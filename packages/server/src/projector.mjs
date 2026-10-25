// projector.mjs : projette le journal brut (event) dans les tables métier.
// - Un tour headless est projeté d'un bloc, dans une transaction, une fois son exécution close.
// - Les projections ne dépendent que du journal (horodatages et clés compris) :
//   rebuild() les reconstruit à l'identique (objectif O2 du cadrage).
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

export const PROJECTOR_VERSION = 2;

// Chemins Windows (C:\…, \\serveur\…) ou POSIX, reconnus à leur forme et non au système qui rejoue :
// un journal écrit sous Windows se projette à l'identique sous Linux (et inversement).
const isWindowsPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
const pathApi = (...paths) => (paths.some((p) => isWindowsPath(String(p ?? ''))) ? win32 : posix);

/** Chemin de `path` relatif à `root`, avec « / » ; '' si égal ; null s'il n'est pas sous root. */
export function inside(root, path) {
  if (!root || !path) return null;
  const api = pathApi(root, path);
  if (!api.isAbsolute(path)) return null;
  const rel = api.relative(root, path); // insensible à la casse pour les chemins Windows
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${api.sep}`) || api.isAbsolute(rel)) return null;
  return rel.split(api.sep).join('/');
}

/** Identifiant stable dérivé de ses composantes (UUID version 8, RFC 9562). */
export function stableId(...parts) {
  const h = createHash('sha256').update(parts.join('\u0000')).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// Nature des outils de Gemini CLI 0.65 (colonne tool_call.tool_kind)
const TOOL_KINDS = {
  read_file: 'read', read_many_files: 'read', list_directory: 'read', read_mcp_resource: 'read',
  write_file: 'edit', replace: 'edit',
  run_shell_command: 'execute',
  glob: 'search', grep_search: 'search', search_file_content: 'search', google_web_search: 'search',
  list_mcp_resources: 'search',
  web_fetch: 'fetch',
  activate_skill: 'skill', invoke_agent: 'agent',
  write_todos: 'think', update_topic: 'think', get_internal_docs: 'think',
  enter_plan_mode: 'think', exit_plan_mode: 'think',
};
export const toolKind = (name) => TOOL_KINDS[name] ?? 'other';

// Extension -> [nature d'artefact, langage, type MIME]
const FILE_TYPES = {
  '.md': ['document', 'markdown', 'text/markdown'], '.txt': ['document', null, 'text/plain'],
  '.html': ['html', 'html', 'text/html'], '.mmd': ['diagram', 'mermaid', 'text/plain'],
  '.svg': ['diagram', 'svg', 'image/svg+xml'],
  '.json': ['data', 'json', 'application/json'], '.csv': ['data', 'csv', 'text/csv'],
  '.yml': ['data', 'yaml', 'application/yaml'], '.yaml': ['data', 'yaml', 'application/yaml'],
  '.sql': ['code', 'sql', 'application/sql'], '.toml': ['code', 'toml', 'application/toml'],
  '.js': ['code', 'javascript', 'text/javascript'], '.mjs': ['code', 'javascript', 'text/javascript'],
  '.ts': ['code', 'typescript', 'text/plain'], '.java': ['code', 'java', 'text/plain'],
  '.py': ['code', 'python', 'text/x-python'], '.css': ['code', 'css', 'text/css'],
  '.scss': ['code', 'scss', 'text/plain'], '.sh': ['code', 'shell', 'text/x-shellscript'],
};
const fileType = (path) => FILE_TYPES[pathApi(path).extname(path).toLowerCase()] ?? ['file', null, 'text/plain'];
const baseName = (path) => pathApi(path).basename(path);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null); // colonnes INTEGER des tables STRICT
const elapsed = (from, to) => {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};
const titleOf = (text) => {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : (line || null);
};
const commandOf = (text) => String(text ?? '').trimStart().match(/^\/([\w:.-]+)/)?.[0] ?? null;
const lastLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? null;
const parse = (json) => { try { return JSON.parse(json); } catch { return null; } };

/** Chemin relatif au dossier racine s'il s'y trouve, sinon chemin absolu inchangé. */
const relativeTo = (root, path) => inside(root, path) || path;

export function createProjector(db, { version = PROJECTOR_VERSION } = {}) {
  const q = {
    nextPending: db.prepare('SELECT * FROM event WHERE projected_at IS NULL ORDER BY id LIMIT 1'),
    run: db.prepare('SELECT * FROM engine_run WHERE id = ?'),
    runEvents: db.prepare('SELECT * FROM event WHERE engine_run_id = ? ORDER BY id'),
    markRun: db.prepare('UPDATE event SET projected_at = ?, projector_version = ? WHERE engine_run_id = ?'),
    markOne: db.prepare('UPDATE event SET projected_at = ?, projector_version = ? WHERE id = ?'),
    tombstone: db.prepare(`SELECT 1 FROM event
      WHERE source = 'board' AND type = 'conversation.delete' AND engine_session_id = ? LIMIT 1`),
    projects: db.prepare('SELECT id, root_path FROM project WHERE root_path IS NOT NULL'),
    project: db.prepare('SELECT id, root_path FROM project WHERE id = ?'),
    upsertProject: db.prepare(`INSERT INTO project
        (id, slug, name, description, instructions, root_path, gemini_project_hash, repo_url, trusted, capture, created_at, updated_at)
      VALUES (@id, @slug, @name, @description, @instructions, @root_path, @gemini_project_hash, @repo_url, @trusted, @capture, @at, @at)
      ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, name = excluded.name, description = excluded.description,
        instructions = excluded.instructions, root_path = excluded.root_path,
        gemini_project_hash = excluded.gemini_project_hash, repo_url = excluded.repo_url,
        trusted = excluded.trusted, capture = excluded.capture, updated_at = excluded.updated_at`),
    conversation: db.prepare('SELECT * FROM conversation WHERE id = ?'),
    insertConversation: db.prepare(`INSERT INTO conversation
        (id, project_id, engine_id, engine_session_id, channel, title, cwd, approval_mode, started_at, updated_at)
      VALUES (@id, @projectId, @engineId, @id, 'headless', @title, @cwd, @approvalMode, @startedAt, @startedAt)`),
    setApproval: db.prepare('UPDATE conversation SET approval_mode = ? WHERE id = ?'),
    setModel: db.prepare('UPDATE conversation SET model = ? WHERE id = ?'),
    deleteConversation: db.prepare('DELETE FROM conversation WHERE id = ?'),
    nextTurnSeq: db.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM turn WHERE conversation_id = ?'),
    nextItemSeq: db.prepare(`SELECT max(
        coalesce((SELECT max(seq) FROM message WHERE conversation_id = @c), 0),
        coalesce((SELECT max(seq) FROM tool_call WHERE conversation_id = @c), 0)) + 1 AS n`),
    insertTurn: db.prepare(`INSERT INTO turn (conversation_id, seq, engine_run_id, command_name, status, started_at)
      VALUES (@conversationId, @seq, @runId, @command, 'running', @startedAt)`),
    closeTurn: db.prepare(`UPDATE turn SET status = @status, stop_reason = @stopReason, error_message = @errorMessage,
        model = @model, input_tokens = @inputTokens, output_tokens = @outputTokens, cached_tokens = @cachedTokens,
        stats_json = @stats, ended_at = @endedAt, duration_ms = @duration
      WHERE id = @id`),
    insertMessage: db.prepare(`INSERT INTO message (conversation_id, turn_id, seq, role, content, created_at, completed_at)
      VALUES (@conversationId, @turnId, @seq, @role, @content, @createdAt, @completedAt)`),
    insertTool: db.prepare(`INSERT INTO tool_call
        (conversation_id, turn_id, seq, engine_call_id, tool_name, tool_kind, component_id, input_json, status, started_at)
      VALUES (@conversationId, @turnId, @seq, @callId, @name, @kind, @componentId, @input, 'in_progress', @startedAt)`),
    closeTool: db.prepare(`UPDATE tool_call SET status = @status, output_text = @output, error_message = @error,
        ended_at = @endedAt, duration_ms = @duration WHERE id = @id`),
    closeOpenTools: db.prepare(`UPDATE tool_call SET status = @status, error_message = coalesce(error_message, @error)
      WHERE turn_id = @turnId AND status = 'in_progress'`),
    component: db.prepare(`SELECT id FROM component WHERE kind = @kind AND name = @name AND enabled = 1
      ORDER BY (project_id IS @projectId) DESC,
        CASE scope WHEN 'workspace' THEN 0 WHEN 'user' THEN 1 WHEN 'extension' THEN 2 WHEN 'builtin' THEN 3 ELSE 4 END
      LIMIT 1`),
    currentVersion: db.prepare('SELECT version_id FROM v_component_current WHERE id = ?'),
    insertUsage: db.prepare(`INSERT INTO component_usage
        (conversation_id, turn_id, component_id, component_version_id, usage, tool_call_id, at)
      VALUES (@conversationId, @turnId, @componentId, @versionId, @usage, @toolCallId, @at)`),
    artifactInProject: db.prepare('SELECT id FROM artifact WHERE project_id = @projectId AND path = @path'),
    artifactInConversation: db.prepare(`SELECT id FROM artifact
      WHERE project_id IS NULL AND conversation_id = @conversationId AND path = @path`),
    insertArtifact: db.prepare(`INSERT INTO artifact (id, project_id, conversation_id, kind, title, path, language, created_at, updated_at)
      VALUES (@id, @projectId, @conversationId, @kind, @title, @path, @language, @at, @at)`),
    touchArtifact: db.prepare('UPDATE artifact SET updated_at = @at WHERE id = @id'),
    nextArtifactVersion: db.prepare('SELECT coalesce(max(version), 0) + 1 AS n FROM artifact_version WHERE artifact_id = ?'),
    insertArtifactVersion: db.prepare(`INSERT INTO artifact_version
        (artifact_id, version, content, mime, sha256, size_bytes, origin, tool_call_id, created_at)
      VALUES (@artifactId, @version, @content, @mime, @sha256, @size, 'agent', @toolCallId, @at)`),
  };

  // Projet dont le dossier racine contient cwd (le plus profond l'emporte)
  function projectFor(cwd) {
    let best = null;
    for (const p of q.projects.all()) {
      if (inside(p.root_path, cwd) !== null && (!best || p.root_path.length > best.root_path.length)) best = p;
    }
    return best;
  }

  function projectArtifact(conv, root, tool, snapshot, at) {
    const params = tool.event.parameters ?? {};
    const absolutePath = snapshot?.path ?? params.file_path ?? params.absolute_path ?? params.path;
    const content = snapshot?.content ?? (tool.event.tool_name === 'write_file' ? params.content : undefined);
    if (!absolutePath || typeof content !== 'string') return; // replace sans instantané : pas de version
    const path = relativeTo(root, absolutePath);
    const [kind, language, mime] = fileType(path);
    let artifact = conv.project_id
      ? q.artifactInProject.get({ projectId: conv.project_id, path })
      : q.artifactInConversation.get({ conversationId: conv.id, path });
    if (!artifact) {
      artifact = { id: stableId('artifact', conv.project_id ?? conv.id, path) };
      q.insertArtifact.run({ id: artifact.id, projectId: conv.project_id, conversationId: conv.id, kind,
        title: baseName(path), path, language, at });
    }
    q.insertArtifactVersion.run({ artifactId: artifact.id, version: q.nextArtifactVersion.get(artifact.id).n, content,
      mime, sha256: sha256(content), size: Buffer.byteLength(content), toolCallId: tool.id, at });
    q.touchArtifact.run({ id: artifact.id, at });
  }

  function projectRun(run, at) {
    const events = q.runEvents.all(run.id);
    const sessionId = events.find((e) => e.engine_session_id)?.engine_session_id;
    if (!sessionId || q.tombstone.get(sessionId)) { q.markRun.run(at, version, run.id); return; }

    const promptEvent = events.find((e) => e.direction === 'out' && e.type === 'prompt');
    const prompt = (promptEvent && parse(promptEvent.payload_json)) ?? { text: '' };

    // Discussion : créée au premier tour, rattachée au projet dont le dossier contient cwd
    let conv = q.conversation.get(sessionId);
    if (!conv) {
      q.insertConversation.run({ id: sessionId, projectId: projectFor(run.cwd)?.id ?? null, engineId: run.engine_id,
        title: titleOf(prompt.text), cwd: run.cwd, approvalMode: prompt.approvalMode ?? null, startedAt: run.started_at });
    } else if (prompt.approvalMode) {
      q.setApproval.run(prompt.approvalMode, sessionId);
    }
    conv = q.conversation.get(sessionId);
    const root = (conv.project_id && q.project.get(conv.project_id)?.root_path) || run.cwd;

    // Tour et message de l'utilisateur (le texte envoyé, pas l'écho de Gemini CLI)
    const turnId = Number(q.insertTurn.run({ conversationId: sessionId, seq: q.nextTurnSeq.get(sessionId).n, runId: run.id,
      command: commandOf(prompt.text), startedAt: run.started_at }).lastInsertRowid);
    let seq = q.nextItemSeq.get({ c: sessionId }).n;
    q.insertMessage.run({ conversationId: sessionId, turnId, seq: seq++, role: 'user', content: String(prompt.text ?? ''),
      createdAt: run.started_at, completedAt: run.started_at });

    const snapshots = new Map(events
      .filter((e) => e.source === 'board' && e.type === 'artifact.snapshot')
      .map((e) => parse(e.payload_json)).filter(Boolean).map((p) => [p.tool_id, p]));
    const tools = new Map();
    let buffer = null;
    let result = null;
    let lastError = null;
    let model = null;
    const flush = () => {
      if (!buffer) return;
      q.insertMessage.run({ conversationId: sessionId, turnId, seq: seq++, role: 'assistant', content: buffer.text,
        createdAt: buffer.first, completedAt: buffer.last });
      buffer = null;
    };

    for (const e of events) {
      if (e.source !== 'headless' || e.direction !== 'in') continue;
      const ev = parse(e.payload_json);
      if (!ev) continue;
      const ts = typeof ev.timestamp === 'string' ? ev.timestamp : e.received_at;
      switch (ev.type) {
        case 'init':
          model = ev.model ?? model;
          break;
        case 'message':
          if (ev.role !== 'assistant') break; // le message user est déjà projeté depuis le prompt envoyé
          if (!buffer) buffer = { text: '', first: ts, last: ts };
          buffer.text += ev.content ?? '';
          buffer.last = ts;
          break;
        case 'tool_use': {
          flush();
          const name = ev.tool_name ?? 'inconnu';
          const target = name === 'activate_skill' ? ['skill', ev.parameters?.name, 'activated']
            : name === 'invoke_agent' ? ['agent', ev.parameters?.agent_name, 'delegated'] : null;
          const componentId = target && target[1]
            ? q.component.get({ kind: target[0], name: target[1], projectId: conv.project_id })?.id ?? null : null;
          const id = Number(q.insertTool.run({ conversationId: sessionId, turnId, seq: seq++, callId: ev.tool_id ?? null,
            name, kind: toolKind(name), componentId, input: JSON.stringify(ev.parameters ?? {}), startedAt: ts }).lastInsertRowid);
          if (ev.tool_id) tools.set(ev.tool_id, { id, event: ev, startedAt: ts });
          if (componentId) {
            q.insertUsage.run({ conversationId: sessionId, turnId, componentId,
              versionId: q.currentVersion.get(componentId)?.version_id ?? null, usage: target[2], toolCallId: id, at: ts });
          }
          break;
        }
        case 'tool_result': {
          const tool = tools.get(ev.tool_id);
          if (!tool) break;
          const ok = ev.status === 'success';
          q.closeTool.run({ id: tool.id, status: ok ? 'completed' : 'failed', output: ev.output ?? null,
            error: ev.error?.message ?? null, endedAt: ts, duration: elapsed(tool.startedAt, ts) });
          if (ok && (tool.event.tool_name === 'write_file' || tool.event.tool_name === 'replace')) {
            projectArtifact(conv, root, tool, snapshots.get(ev.tool_id), ts);
          }
          break;
        }
        case 'error':
          if (ev.severity === 'error') lastError = ev.message ?? 'erreur';
          break;
        case 'result':
          flush();
          result = ev;
          break;
        default:
          break; // raw et types inconnus : restent dans le journal
      }
    }
    flush();

    // Clôture du tour : un result en succès fait foi ; puis l'arrêt demandé par l'humain (turn.cancel),
    // qui vaut aussi sous Windows où le code de sortie n'est pas 130 ; puis result en erreur ; puis le code de sortie
    const cancelRequested = events.some((e) => e.source === 'board' && e.type === 'turn.cancel');
    let status;
    let stopReason;
    let errorMessage = null;
    if (result?.status === 'success') {
      status = 'completed';
      stopReason = 'end_turn';
    } else if (cancelRequested) {
      status = 'cancelled';
      stopReason = 'cancelled';
    } else if (result) {
      status = 'error';
      stopReason = result.error?.type ?? 'error';
      errorMessage = result.error?.message ?? lastError;
    } else if (run.exit_code === 130 || run.exit_code === null) {
      status = 'cancelled';
      stopReason = 'cancelled';
    } else if (run.exit_code === 53) {
      status = 'limit';
      stopReason = 'max_turns';
    } else {
      status = 'error';
      stopReason = `exit_${run.exit_code}`;
      errorMessage = lastError ?? lastLine(run.stderr_tail) ?? `code de sortie ${run.exit_code}`;
    }
    q.closeOpenTools.run({ turnId, status: status === 'cancelled' ? 'cancelled' : 'failed', error: 'aucun résultat reçu' });
    const stats = result?.stats ?? null;
    const endedAt = result?.timestamp ?? run.ended_at;
    q.closeTurn.run({ id: turnId, status, stopReason, errorMessage, model,
      inputTokens: int(stats?.input_tokens), outputTokens: int(stats?.output_tokens), cachedTokens: int(stats?.cached),
      stats: stats ? JSON.stringify(stats) : null, endedAt,
      duration: int(stats?.duration_ms) ?? elapsed(run.started_at, endedAt) });
    if (model) q.setModel.run(model, sessionId);
    q.markRun.run(at, version, run.id);
  }

  function projectBoard(e, at) {
    const p = parse(e.payload_json) ?? {};
    if (e.type === 'project.upsert' && p.id && p.slug && p.name) {
      q.upsertProject.run({
        id: p.id, slug: p.slug, name: p.name, description: p.description ?? null, instructions: p.instructions ?? null,
        root_path: p.root_path ?? null, gemini_project_hash: p.gemini_project_hash ?? null, repo_url: p.repo_url ?? null,
        trusted: p.trusted ? 1 : 0, capture: p.capture ?? 'full', at: e.received_at,
      });
    } else if (e.type === 'conversation.delete') {
      q.deleteConversation.run(e.engine_session_id ?? p.conversation_id ?? '');
    }
    q.markOne.run(at, version, e.id); // types inconnus de cette version : ignorés
  }

  /**
   * Projette les événements en attente, dans l'ordre du journal.
   * S'arrête au premier tour encore ouvert : la suite attend sa clôture.
   */
  function projectPending() {
    let projected = 0;
    for (;;) {
      const e = q.nextPending.get();
      if (!e) break;
      const at = new Date().toISOString();
      if (e.engine_run_id) {
        const run = q.run.get(e.engine_run_id);
        if (run && !run.ended_at) break;
        if (run) db.transaction(() => projectRun(run, at))();
        else q.markOne.run(at, version, e.id); // exécution inconnue : événement orphelin
      } else if (e.source === 'board') {
        db.transaction(() => projectBoard(e, at))();
      } else {
        q.markOne.run(at, version, e.id); // hooks, import, ACP : étapes 6 et 8
      }
      projected++;
    }
    return projected;
  }

  /** Efface les projections et rejoue tout le journal. Le catalogue et les projets ne sont pas effacés. */
  function rebuild() {
    db.transaction(() => {
      db.prepare('DELETE FROM conversation').run();
      db.prepare('DELETE FROM artifact').run();
      db.prepare('UPDATE event SET projected_at = NULL, projector_version = NULL').run();
    })();
    return projectPending();
  }

  return { projectPending, rebuild };
}
