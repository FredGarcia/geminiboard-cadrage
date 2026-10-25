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
      (received_at, source, direction, type, engine_id, engine_version, engine_run_id, engine_session_id, payload_json)
    VALUES (@at, @source, @direction, @type, @engineId, @engineVersion, @runId, @sessionId, @payload)`);
  const openRuns = db.prepare('SELECT id FROM engine_run WHERE ended_at IS NULL');

  return {
    /** Début d'un tour : exécution et prompt envoyé (le prompt n'est jamais dans argv). */
    start({ runId, sessionId, cwd, args = [], pid = null, prompt, approvalMode = 'default', resume = false,
      engineId = 'gemini-cli', engineVersion = null, startedAt = now() }) {
      db.transaction(() => {
        insertRun.run({ id: runId, engineId, engineVersion, argv: JSON.stringify(['gemini', ...args]), cwd, pid, startedAt });
        insertEvent.run({ at: startedAt, source: 'headless', direction: 'out', type: 'prompt', engineId, engineVersion,
          runId, sessionId, payload: JSON.stringify({ text: prompt, approvalMode, resume }) });
      })();
    },

    /** Un événement stream-json reçu, tel quel. */
    event({ runId, sessionId, event, engineId = 'gemini-cli', engineVersion = null, at = now() }) {
      insertEvent.run({ at, source: 'headless', direction: 'in', type: String(event?.type ?? 'raw'), engineId, engineVersion,
        runId, sessionId, payload: JSON.stringify(event) });
    },

    /** Contenu d'un fichier relu après write_file ou replace : rend les artefacts rejouables. */
    snapshot({ runId, sessionId, toolId, path, content, at = now() }) {
      insertEvent.run({ at, source: 'board', direction: 'internal', type: 'artifact.snapshot', engineId: null,
        engineVersion: null, runId, sessionId, payload: JSON.stringify({ tool_id: toolId, path, content }) });
    },

    /** Arrêt demandé par l'humain : fait foi même sans code 130 (Windows n'a pas de SIGINT). */
    cancel({ runId, sessionId, at = now() }) {
      insertEvent.run({ at, source: 'board', direction: 'internal', type: 'turn.cancel', engineId: null,
        engineVersion: null, runId, sessionId, payload: JSON.stringify({ by: 'human' }) });
    },

    /** Fin du processus. */
    end({ runId, code, stderr = '', endedAt = now() }) {
      endRun.run({ id: runId, code, stderr: String(stderr).slice(-4096), endedAt });
    },

    /** Action de gestion (project.upsert, conversation.delete…). */
    board({ type, sessionId = null, payload = {}, at = now() }) {
      insertEvent.run({ at, source: 'board', direction: 'internal', type, engineId: null, engineVersion: null,
        runId: null, sessionId, payload: JSON.stringify(payload) });
    },

    /** Au démarrage du serveur : clôt les tours restés ouverts après un arrêt brutal. */
    recoverOpenRuns({ at = now() } = {}) {
      const ids = openRuns.all().map((r) => r.id);
      for (const id of ids) endRun.run({ id, code: null, stderr: '[tour interrompu : arrêt du serveur]', endedAt: at });
      return ids;
    },
  };
}
