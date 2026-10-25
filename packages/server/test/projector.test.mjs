// Projection du journal brut dans les tables métier (étape 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshBoard, recordTurn, projections, T } from './helpers.mjs';
import { stableId, toolKind } from '../src/projector.mjs';

const S1 = '01a17300-0000-7000-8000-000000000001';
const S2 = '01a17300-0000-7000-8000-000000000002';
const P = '01a17300-0000-7000-8000-0000000000aa';
const stats = { total_tokens: 30, input_tokens: 20, output_tokens: 10, cached: 4, input: 16, duration_ms: 1500, tool_calls: 0, models: {} };

const messages = (db, s) => db.prepare('SELECT seq, role, content FROM message WHERE conversation_id = ? ORDER BY seq').all(s);
const turns = (db, s) => db.prepare('SELECT * FROM turn WHERE conversation_id = ? ORDER BY seq').all(s);

test('tour simple : discussion, titre, modèle, fragments réunis, statistiques', () => {
  const { db, rec, proj } = freshBoard();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'Explique le schéma\nen détail', events: [
    { type: 'init', session_id: S1, model: 'gemini-2.5-pro' },
    { type: 'message', role: 'user', content: 'écho ignoré' },
    { type: 'message', role: 'assistant', content: 'Bon', delta: true },
    { type: 'message', role: 'assistant', content: 'jour.', delta: true },
    { type: 'result', status: 'success', stats },
  ] });
  assert.equal(proj.projectPending(), 1);
  const c = db.prepare('SELECT * FROM conversation WHERE id = ?').get(S1);
  assert.equal(c.title, 'Explique le schéma');
  assert.equal(c.model, 'gemini-2.5-pro');
  assert.equal(c.channel, 'headless');
  assert.equal(c.approval_mode, 'default');
  assert.deepEqual(messages(db, S1).map((m) => [m.seq, m.role, m.content]),
    [[1, 'user', 'Explique le schéma\nen détail'], [2, 'assistant', 'Bonjour.']]);
  const [t] = turns(db, S1);
  assert.equal(t.status, 'completed');
  assert.equal(t.stop_reason, 'end_turn');
  assert.deepEqual([t.input_tokens, t.output_tokens, t.cached_tokens, t.duration_ms], [20, 10, 4, 1500]);
  assert.equal(c.updated_at, T(3)); // début du dernier message (réponse)
  assert.equal(db.prepare(`SELECT count(*) n FROM message_fts WHERE message_fts MATCH 'bonjour'`).get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM event WHERE projected_at IS NULL').get().n, 0);
});

test('outils : chronologie message, outil, message ; nature et durée', () => {
  const { db, rec, proj } = freshBoard();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'Lis notes.md', events: [
    { type: 'message', role: 'assistant', content: 'Je lis.', delta: true },
    { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: '/travail/projet/notes.md' } },
    { type: 'tool_result', tool_id: 't1', status: 'success', output: '# Notes' },
    { type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't2', parameters: { command: 'ls' } },
    { type: 'tool_result', tool_id: 't2', status: 'error', error: { type: 'policy', message: 'refusé' } },
    { type: 'message', role: 'assistant', content: 'Fini.', delta: true },
    { type: 'result', status: 'success', stats },
  ] });
  proj.projectPending();
  const timeline = db.prepare('SELECT seq, item_type, label FROM v_timeline WHERE conversation_id = ? ORDER BY seq').all(S1);
  assert.deepEqual(timeline.map((x) => `${x.seq}:${x.item_type}:${x.label}`), [
    '1:message:user', '2:message:assistant', '3:tool_call:read_file [completed]',
    '4:tool_call:run_shell_command [failed]', '5:message:assistant']);
  const tools = db.prepare('SELECT * FROM tool_call ORDER BY seq').all();
  assert.deepEqual(tools.map((x) => [x.tool_kind, x.engine_call_id, x.output_text, x.error_message, x.duration_ms]),
    [['read', 't1', '# Notes', null, 1000], ['execute', 't2', null, 'refusé', 1000]]);
  assert.equal(JSON.parse(tools[0].input_json).file_path, '/travail/projet/notes.md');
});

test('result en erreur : tour en erreur, message conservé, outil sans résultat clos', () => {
  const { db, rec, proj } = freshBoard();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'x', code: 144, events: [
    { type: 'init', session_id: S1, model: 'auto' },
    { type: 'tool_use', tool_name: 'glob', tool_id: 't1', parameters: { pattern: '*' } },
    { type: 'error', severity: 'warning', message: 'lent' },
    { type: 'result', status: 'error', error: { type: 'unknown', message: '[API Error: 400]' } },
  ] });
  proj.projectPending();
  const [t] = turns(db, S1);
  assert.deepEqual([t.status, t.stop_reason, t.error_message], ['error', 'unknown', '[API Error: 400]']);
  assert.equal(db.prepare('SELECT status FROM tool_call').get().status, 'failed');
});

test('sans result : annulation (130 ou signal), limite (53), erreur tirée de stderr (41)', () => {
  const { db, rec, proj } = freshBoard();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'a', code: 130, events: [
    { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: {} }] });
  recordTurn(rec, { sessionId: S2, runId: 'r2', prompt: 'b', code: null, start: 10 });
  recordTurn(rec, { sessionId: '01a17300-0000-7000-8000-000000000003', runId: 'r3', prompt: 'c', code: 53, start: 20 });
  recordTurn(rec, { sessionId: '01a17300-0000-7000-8000-000000000004', runId: 'r4', prompt: 'd', code: 41, start: 30,
    stderr: 'trace\nPlease set an Auth method before running.\n' });
  proj.projectPending();
  const status = db.prepare('SELECT t.status, t.stop_reason, t.error_message FROM turn t ORDER BY t.id').all();
  assert.deepEqual(status.map((s) => [s.status, s.stop_reason, s.error_message]), [
    ['cancelled', 'cancelled', null], ['cancelled', 'cancelled', null], ['limit', 'max_turns', null],
    ['error', 'exit_41', 'Please set an Auth method before running.']]);
  assert.equal(db.prepare('SELECT status FROM tool_call').get().status, 'cancelled');
  assert.equal(db.prepare(`SELECT count(*) n FROM message WHERE role = 'user'`).get().n, 4);
});

test('plusieurs tours : séquences continues, titre conservé, mode d\'approbation suivi', () => {
  const { db, rec, proj } = freshBoard();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'Premier', events: [
    { type: 'message', role: 'assistant', content: 'Un.' }, { type: 'result', status: 'success' }] });
  recordTurn(rec, { sessionId: S1, runId: 'r2', prompt: '/git:commit message', approvalMode: 'auto_edit', start: 10, events: [
    { type: 'message', role: 'assistant', content: 'Deux.' }, { type: 'result', status: 'success' }] });
  proj.projectPending();
  assert.deepEqual(turns(db, S1).map((t) => [t.seq, t.command_name]), [[1, null], [2, '/git:commit']]);
  assert.deepEqual(messages(db, S1).map((m) => m.seq), [1, 2, 3, 4]);
  const c = db.prepare('SELECT title, approval_mode FROM conversation WHERE id = ?').get(S1);
  assert.deepEqual({ ...c }, { title: 'Premier', approval_mode: 'auto_edit' });
});

test('artefacts : write_file, réécriture, replace avec et sans instantané, chemin relatif au projet', () => {
  const { db, rec, proj } = freshBoard();
  rec.board({ type: 'project.upsert', payload: { id: P, slug: 'board', name: 'Board', root_path: '/travail/projet', trusted: true }, at: T(0) });
  const file = '/travail/projet/docs/notes.md';
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'Écris', start: 1, events: [
    { type: 'tool_use', tool_name: 'write_file', tool_id: 'w1', parameters: { file_path: file, content: 'v1' } },
    { type: 'tool_result', tool_id: 'w1', status: 'success' },
    { type: 'tool_use', tool_name: 'write_file', tool_id: 'w2', parameters: { file_path: file, content: 'v2' } },
    { type: 'tool_result', tool_id: 'w2', status: 'success' },
    { type: 'tool_use', tool_name: 'replace', tool_id: 'r1', parameters: { file_path: file, old_string: 'v2', new_string: 'v3' } },
    { type: 'tool_result', tool_id: 'r1', status: 'success' },
    { type: 'tool_use', tool_name: 'replace', tool_id: 'r2', parameters: { file_path: file, old_string: 'v3', new_string: 'v4' } },
    { type: 'tool_result', tool_id: 'r2', status: 'success' },
    { type: 'tool_use', tool_name: 'write_file', tool_id: 'w3', parameters: { file_path: '/ailleurs/x.sql', content: 'select 1;' } },
    { type: 'tool_result', tool_id: 'w3', status: 'error', error: { type: 'policy', message: 'refusé' } },
    { type: 'result', status: 'success' },
  ], snapshots: [{ toolId: 'r1', path: file, content: 'v3' }] });
  proj.projectPending();
  assert.equal(db.prepare('SELECT project_id FROM conversation').get().project_id, P);
  const arts = db.prepare('SELECT * FROM artifact').all();
  assert.equal(arts.length, 1, 'un seul artefact : write_file refusé et replace sans instantané ignorés');
  assert.deepEqual([arts[0].id, arts[0].path, arts[0].kind, arts[0].language, arts[0].title],
    [stableId('artifact', P, 'docs/notes.md'), 'docs/notes.md', 'document', 'markdown', 'notes.md']);
  const versions = db.prepare('SELECT version, content, mime, size_bytes FROM artifact_version ORDER BY version').all();
  assert.deepEqual(versions.map((v) => [v.version, v.content, v.mime, v.size_bytes]),
    [[1, 'v1', 'text/markdown', 2], [2, 'v2', 'text/markdown', 2], [3, 'v3', 'text/markdown', 2]]);
  assert.equal(db.prepare(`SELECT count(*) n FROM artifact_fts WHERE artifact_fts MATCH 'v3'`).get().n, 1);
});

test('composants : activate_skill et invoke_agent tracés avec la version courante', () => {
  const { db, rec, proj } = freshBoard();
  db.prepare(`INSERT INTO component (id, kind, name, scope) VALUES ('k1', 'skill', 'geminiboard', 'user')`).run();
  db.prepare(`INSERT INTO component_version (component_id, version, status, format, content, sha256, ratified_at)
    VALUES ('k1', '1.0.0', 'ratified', 'skill-md', 'x', 'h', '2026-10-25T09:00:00.000Z')`).run();
  db.prepare(`INSERT INTO component (id, kind, name, scope) VALUES ('k2', 'agent', 'relecteur', 'user')`).run();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'Construis', events: [
    { type: 'tool_use', tool_name: 'activate_skill', tool_id: 'a1', parameters: { name: 'geminiboard' } },
    { type: 'tool_result', tool_id: 'a1', status: 'success' },
    { type: 'tool_use', tool_name: 'invoke_agent', tool_id: 'a2', parameters: { agent_name: 'relecteur', prompt: 'relis' } },
    { type: 'tool_result', tool_id: 'a2', status: 'success' },
    { type: 'tool_use', tool_name: 'activate_skill', tool_id: 'a3', parameters: { name: 'inconnu' } },
    { type: 'result', status: 'success' },
  ] });
  proj.projectPending();
  const usage = db.prepare(`SELECT u.usage, c.name, v.version FROM component_usage u JOIN component c ON c.id = u.component_id
    LEFT JOIN component_version v ON v.id = u.component_version_id ORDER BY u.id`).all();
  assert.deepEqual(usage.map((u) => [u.usage, u.name, u.version]), [['activated', 'geminiboard', '1.0.0'], ['delegated', 'relecteur', null]]);
  assert.deepEqual(db.prepare('SELECT tool_kind FROM tool_call ORDER BY seq').all().map((r) => r.tool_kind), ['skill', 'agent', 'skill']);
  assert.equal(toolKind('outil_mcp_maison'), 'other');
});

test('tour ouvert : la projection attend sa clôture ; reprise après arrêt du serveur', () => {
  const { db, rec, proj } = freshBoard();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'long', close: false, events: [{ type: 'init', session_id: S1, model: 'm' }] });
  recordTurn(rec, { sessionId: S2, runId: 'r2', prompt: 'court', start: 10, events: [{ type: 'result', status: 'success' }] });
  assert.equal(proj.projectPending(), 0);
  assert.equal(db.prepare('SELECT count(*) n FROM conversation').get().n, 0);
  assert.deepEqual(rec.recoverOpenRuns({ at: T(30) }), ['r1']);
  assert.equal(proj.projectPending(), 2);
  assert.deepEqual(db.prepare('SELECT status FROM turn ORDER BY id').all().map((r) => r.status), ['cancelled', 'completed']);
});

test('suppression : la discussion disparaît et ne revient pas au rejeu', () => {
  const { db, rec, proj } = freshBoard();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'à oublier', events: [{ type: 'result', status: 'success' }] });
  recordTurn(rec, { sessionId: S2, runId: 'r2', prompt: 'à garder', start: 10, events: [{ type: 'result', status: 'success' }] });
  proj.projectPending();
  rec.board({ type: 'conversation.delete', sessionId: S1, at: T(20) });
  proj.projectPending();
  assert.deepEqual(db.prepare('SELECT id FROM conversation').all().map((r) => r.id), [S2]);
  proj.rebuild();
  assert.deepEqual(db.prepare('SELECT id FROM conversation').all().map((r) => r.id), [S2]);
  assert.equal(db.prepare('SELECT count(*) n FROM event').get().n, 5, 'le journal brut reste complet');
});

test('O2 : effacer les projections puis rejouer le journal redonne le même état', () => {
  const { db, rec, proj } = freshBoard();
  rec.board({ type: 'project.upsert', payload: { id: P, slug: 'board', name: 'Board', root_path: '/travail/projet' }, at: T(0) });
  db.prepare(`INSERT INTO component (id, kind, name, scope) VALUES ('k1', 'skill', 'geminiboard', 'user')`).run();
  recordTurn(rec, { sessionId: S1, runId: 'r1', prompt: 'Écris le fichier', start: 1, events: [
    { type: 'init', session_id: S1, model: 'm1' },
    { type: 'message', role: 'assistant', content: 'Je ', delta: true },
    { type: 'tool_use', tool_name: 'activate_skill', tool_id: 'a1', parameters: { name: 'geminiboard' } },
    { type: 'tool_result', tool_id: 'a1', status: 'success' },
    { type: 'tool_use', tool_name: 'write_file', tool_id: 'w1', parameters: { file_path: '/travail/projet/a.sql', content: 'select 1;' } },
    { type: 'tool_result', tool_id: 'w1', status: 'success' },
    { type: 'message', role: 'assistant', content: 'termine.', delta: true },
    { type: 'result', status: 'success', stats },
  ] });
  recordTurn(rec, { sessionId: S1, runId: 'r2', prompt: 'Encore', start: 20, code: 144, events: [
    { type: 'result', status: 'error', error: { type: 'unknown', message: 'API' } }] });
  recordTurn(rec, { sessionId: S2, runId: 'r3', prompt: 'Autre', start: 30, code: 130 });
  proj.projectPending();
  const before = projections(db);
  assert.deepEqual([before.turn.length, before.message.length, before.tool_call.length, before.artifact.length,
    before.component_usage.length], [3, 5, 2, 1, 1]);
  proj.rebuild();
  assert.deepEqual(projections(db), before);
  proj.rebuild();
  assert.deepEqual(projections(db), before);
});
