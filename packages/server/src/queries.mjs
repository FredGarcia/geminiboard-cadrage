// queries.mjs : lectures de l'API (projets, discussions, fil, artefacts, composants, journal, recherche).
// Lecture seule : toute écriture passe par l'enregistreur (journal), puis par le projecteur.

const parse = (json) => { try { return JSON.parse(json); } catch { return null; } };

/**
 * Requête plein texte FTS5 sûre : chaque mot devient une expression entre guillemets, avec recherche
 * par préfixe. Les opérateurs FTS5 (", *, :, NEAR, AND…) tapés par l'utilisateur restent du texte.
 */
export function ftsQuery(text) {
  const words = String(text ?? '').split(/\s+/).map((w) => w.replace(/"/g, '')).filter(Boolean).slice(0, 12);
  return words.map((w) => `"${w}"*`).join(' ');
}

export function createQueries(db) {
  const q = {
    projects: db.prepare(`SELECT p.*,
        (SELECT count(*) FROM conversation c WHERE c.project_id = p.id) AS conversation_count,
        (SELECT max(c.updated_at) FROM conversation c WHERE c.project_id = p.id) AS last_activity
      FROM project p WHERE p.archived_at IS NULL ORDER BY p.name COLLATE NOCASE`),
    project: db.prepare('SELECT * FROM project WHERE id = ?'),
    projectBySlug: db.prepare('SELECT * FROM project WHERE slug = ?'),
    projectByRoot: db.prepare('SELECT * FROM project WHERE root_path = ?'),
    slugTaken: db.prepare('SELECT 1 FROM project WHERE slug = ?'),
    conversations: db.prepare(`SELECT o.*, c.project_id, c.model, c.approval_mode, c.cwd,
        (SELECT count(*) FROM turn t WHERE t.conversation_id = c.id) AS turn_count
      FROM v_conversation_overview o JOIN conversation c ON c.id = o.id
      WHERE (@projectId IS NULL OR c.project_id = @projectId) AND (@before IS NULL OR c.updated_at < @before)
      ORDER BY c.updated_at DESC, c.id DESC LIMIT @limit`),
    conversation: db.prepare(`SELECT c.*, p.name AS project_name, p.slug AS project_slug
      FROM conversation c LEFT JOIN project p ON p.id = c.project_id WHERE c.id = ?`),
    turns: db.prepare(`SELECT id, seq, engine_run_id, command_name, status, stop_reason, error_message, model,
        input_tokens, output_tokens, cached_tokens, started_at, ended_at, duration_ms
      FROM turn WHERE conversation_id = ? ORDER BY seq`),
    messages: db.prepare(`SELECT m.id, m.seq, m.role, m.content, m.created_at, m.completed_at, t.seq AS turn
      FROM message m LEFT JOIN turn t ON t.id = m.turn_id WHERE m.conversation_id = ? ORDER BY m.seq`),
    tools: db.prepare(`SELECT x.id, x.seq, x.engine_call_id, x.tool_name, x.tool_kind, x.input_json, x.output_text,
        x.status, x.error_message, x.started_at, x.ended_at, x.duration_ms, t.seq AS turn
      FROM tool_call x LEFT JOIN turn t ON t.id = x.turn_id WHERE x.conversation_id = ? ORDER BY x.seq`),
    // Dernière session de Gemini CLI de la discussion qui a abouti au moins une fois : la seule reprenable
    // (une session dont le premier tour a échoué ne se reprend pas, ni ne se recrée : sortie 42)
    resumableSession: db.prepare(`SELECT r.engine_session_id AS id FROM event r
      WHERE r.source = 'headless' AND r.type = 'result' AND json_extract(r.payload_json, '$.status') = 'success'
        AND r.engine_session_id IS NOT NULL
        AND r.engine_run_id IN (SELECT p.engine_run_id FROM event p WHERE p.source = 'headless' AND p.type = 'prompt'
          AND coalesce(json_extract(p.payload_json, '$.conversation_id'), p.engine_session_id) = ?)
      ORDER BY r.id DESC LIMIT 1`),
    conversationDeleted: db.prepare(`SELECT 1 FROM event
      WHERE source = 'board' AND type = 'conversation.delete'
        AND coalesce(json_extract(payload_json, '$.conversation_id'), engine_session_id) = ? LIMIT 1`),
    turnOfRun: db.prepare('SELECT status, stop_reason, error_message, input_tokens, output_tokens, duration_ms FROM turn WHERE engine_run_id = ?'),
    artifacts: db.prepare(`SELECT a.*, v.version, v.size_bytes, v.sha256, v.created_at AS version_at
      FROM artifact a JOIN artifact_version v ON v.artifact_id = a.id
        AND v.version = (SELECT max(version) FROM artifact_version WHERE artifact_id = a.id)
      WHERE (@projectId IS NULL OR a.project_id = @projectId)
        AND (@conversationId IS NULL OR a.conversation_id = @conversationId)
      ORDER BY a.updated_at DESC, a.id LIMIT @limit`),
    artifact: db.prepare('SELECT * FROM artifact WHERE id = ?'),
    artifactVersions: db.prepare(`SELECT version, mime, sha256, size_bytes, origin, tool_call_id, created_at
      FROM artifact_version WHERE artifact_id = ? ORDER BY version`),
    artifactVersion: db.prepare('SELECT * FROM artifact_version WHERE artifact_id = ? AND version = ?'),
    components: db.prepare('SELECT * FROM v_component_current ORDER BY kind, name'),
    events: db.prepare(`SELECT id, received_at, source, direction, type, engine_version, engine_run_id, engine_session_id,
        conversation_id, payload_json, redacted, projected_at, projector_version
      FROM event
      WHERE id > @after AND (@source IS NULL OR source = @source) AND (@type IS NULL OR type = @type)
        AND (@session IS NULL OR engine_session_id = @session)
        AND (@conversation IS NULL OR conversation_id = @conversation)
      ORDER BY id LIMIT @limit`),
    searchMessages: db.prepare(`SELECT m.conversation_id, m.seq, m.role, c.title, c.project_id,
        snippet(message_fts, 0, '[', ']', '…', 12) AS snippet
      FROM message_fts JOIN message m ON m.id = message_fts.rowid JOIN conversation c ON c.id = m.conversation_id
      WHERE message_fts MATCH @query AND (@projectId IS NULL OR c.project_id = @projectId)
      ORDER BY bm25(message_fts) LIMIT @limit`),
    searchArtifacts: db.prepare(`SELECT a.id, a.title, a.path, a.project_id, v.version,
        snippet(artifact_fts, 0, '[', ']', '…', 12) AS snippet
      FROM artifact_fts JOIN artifact_version v ON v.id = artifact_fts.rowid JOIN artifact a ON a.id = v.artifact_id
      WHERE artifact_fts MATCH @query AND (@projectId IS NULL OR a.project_id = @projectId)
        AND v.version = (SELECT max(version) FROM artifact_version WHERE artifact_id = a.id)
      ORDER BY bm25(artifact_fts) LIMIT @limit`),
    searchDocuments: db.prepare(`SELECT d.id, d.project_id, d.title, snippet(document_fts, 1, '[', ']', '…', 12) AS snippet
      FROM document_fts JOIN project_document d ON d.id = document_fts.rowid
      WHERE document_fts MATCH @query AND (@projectId IS NULL OR d.project_id = @projectId)
      ORDER BY bm25(document_fts) LIMIT @limit`),
    counts: db.prepare(`SELECT (SELECT count(*) FROM event) AS events, (SELECT count(*) FROM conversation) AS conversations,
        (SELECT count(*) FROM project) AS projects, (SELECT count(*) FROM artifact) AS artifacts`),
  };

  const project = (row) => row && { ...row, trusted: Boolean(row.trusted) };

  return {
    listProjects: () => q.projects.all().map(project),
    getProject: (id) => project(q.project.get(id)),
    getProjectBySlug: (slug) => project(q.projectBySlug.get(slug)),
    getProjectByRoot: (root) => project(q.projectByRoot.get(root)),
    slugTaken: (slug) => Boolean(q.slugTaken.get(slug)),
    listConversations: ({ projectId = null, before = null, limit = 50 } = {}) =>
      q.conversations.all({ projectId, before, limit }).map((c) => ({ ...c, starred: Boolean(c.starred) })),
    getConversation: (id) => {
      const c = q.conversation.get(id);
      return c && { ...c, starred: Boolean(c.starred), turns: q.turns.all(id) };
    },
    /** Fil d'une discussion : messages et appels d'outils dans l'ordre de leur séquence partagée. */
    timeline: (id) => {
      const items = [
        ...q.messages.all(id).map((m) => ({ kind: 'message', ...m })),
        ...q.tools.all(id).map(({ input_json: input, ...t }) => ({ kind: 'tool_call', ...t, input: parse(input) })),
      ];
      return items.sort((a, b) => a.seq - b.seq);
    },
    resumableSession: (conversationId) => q.resumableSession.get(conversationId)?.id ?? null,
    conversationDeleted: (id) => Boolean(q.conversationDeleted.get(id)),
    turnOfRun: (runId) => q.turnOfRun.get(runId) ?? null,
    listArtifacts: ({ projectId = null, conversationId = null, limit = 50 } = {}) =>
      q.artifacts.all({ projectId, conversationId, limit }).map((a) => ({ ...a, pinned: Boolean(a.pinned) })),
    getArtifact: (id) => {
      const a = q.artifact.get(id);
      return a && { ...a, pinned: Boolean(a.pinned), versions: q.artifactVersions.all(id) };
    },
    getArtifactVersion: (id, version) => q.artifactVersion.get(id, version) ?? null,
    listComponents: () => q.components.all().map((c) => ({ ...c, enabled: Boolean(c.enabled) })),
    listEvents: ({ after = 0, limit = 100, source = null, type = null, session = null, conversation = null } = {}) =>
      q.events.all({ after, limit, source, type, session, conversation }).map(({ payload_json: p, ...e }) => ({
        ...e, redacted: Boolean(e.redacted), payload: parse(p),
      })),
    search: ({ text, projectId = null, limit = 20 }) => {
      const query = ftsQuery(text);
      if (!query) return { messages: [], artifacts: [], documents: [] };
      const args = { query, projectId, limit };
      return {
        messages: q.searchMessages.all(args),
        artifacts: q.searchArtifacts.all(args),
        documents: q.searchDocuments.all(args),
      };
    },
    counts: () => q.counts.get(),
    schemaVersion: () => db.pragma('user_version', { simple: true }),
  };
}
