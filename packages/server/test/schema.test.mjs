// Contrôles du schéma : migration, contraintes, plein texte, journal en ajout seul, vues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal, migrate, MIGRATIONS_DIR } from '../src/journal.mjs';

const P = '0192f000-0000-7000-8000-000000000001';
const C = '0192f000-0000-7000-8000-0000000000c1';
const A = '0192f000-0000-7000-8000-0000000000a1';
const SKILL = '0192f000-0000-7000-8000-0000000000d1';
const CMD = '0192f000-0000-7000-8000-0000000000d2';

function seed(db) {
  db.prepare(`INSERT INTO project (id, slug, name, root_path) VALUES (?, 'geminiboard', 'GeminiBoard', '/travail/projet')`).run(P);
  db.prepare(`INSERT INTO conversation (id, project_id, engine_id, engine_session_id, channel, title)
    VALUES (?, ?, 'gemini-cli', ?, 'headless', 'Schéma')`).run(C, P, C);
  const turnId = db.prepare(`INSERT INTO turn (conversation_id, seq) VALUES (?, 1)`).run(C).lastInsertRowid;
  db.prepare(`INSERT INTO message (conversation_id, turn_id, seq, role, content) VALUES (?, ?, 1, 'user', 'Propose le schéma de développement')`).run(C, turnId);
  const toolId = db.prepare(`INSERT INTO tool_call (conversation_id, turn_id, seq, tool_name, tool_kind, status)
    VALUES (?, ?, 2, 'write_file', 'edit', 'completed')`).run(C, turnId).lastInsertRowid;
  db.prepare(`INSERT INTO message (conversation_id, turn_id, seq, role, content) VALUES (?, ?, 3, 'assistant', 'Voici les éléments.')`).run(C, turnId);
  db.prepare(`INSERT INTO artifact (id, project_id, conversation_id, kind, title, path) VALUES (?, ?, ?, 'code', 'init.sql', 'init.sql')`).run(A, P, C);
  db.prepare(`INSERT INTO artifact_version (artifact_id, version, content, mime, sha256, size_bytes, origin, tool_call_id)
    VALUES (?, 1, 'CREATE TABLE éléments ();', 'application/sql', 'x', 25, 'agent', ?)`).run(A, toolId);
  db.prepare(`INSERT INTO component (id, kind, name, scope, targets) VALUES (?, 'skill', 'agent-tdd-jira', 'user', 'both')`).run(SKILL);
  db.prepare(`INSERT INTO component_version (component_id, version, status, format, content, sha256, ratified_at, created_at)
    VALUES (?, '1.1.0', 'ratified', 'skill-md', 'x', 'h1', '2026-10-21T10:00:00.000Z', '2026-10-21T10:00:00.000Z')`).run(SKILL);
  db.prepare(`INSERT INTO component_version (component_id, version, status, format, content, sha256, created_at)
    VALUES (?, '1.2.0', 'draft', 'skill-md', 'x', 'h2', '2026-10-25T10:00:00.000Z')`).run(SKILL);
  db.prepare(`INSERT INTO component (id, kind, name, scope, project_id) VALUES (?, 'command', 'board:plan', 'workspace', ?)`).run(CMD, P);
  return { turnId, toolId };
}

test('migration : fichier WAL, version 1, empreinte vérifiée, pas de double application', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-schema-'));
  try {
    const path = join(dir, 'board.db');
    let db = openJournal(path);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.prepare('SELECT count(*) n FROM schema_migration').get().n, 1);
    db.close();
    db = openJournal(path); // deuxième ouverture : rien à appliquer
    assert.equal(db.prepare('SELECT count(*) n FROM schema_migration').get().n, 1);

    // Une copie aux fins de ligne Windows (CRLF) reste la même migration
    const crlf = mkdtempSync(join(tmpdir(), 'gb-mig-'));
    const lf = readFileSync(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(join(crlf, '001_init.sql'), lf.replace(/\n/g, '\r\n'));
    assert.deepEqual(migrate(db, crlf), []);
    rmSync(crlf, { recursive: true, force: true });

    // Une migration modifiée après application est refusée
    const altered = mkdtempSync(join(tmpdir(), 'gb-mig-'));
    copyFileSync(join(MIGRATIONS_DIR, '001_init.sql'), join(altered, '001_init.sql'));
    appendFileSync(join(altered, '001_init.sql'), '\n-- modification\n');
    assert.throws(() => migrate(db, altered), /modifiée après application/);

    // Une nouvelle migration s'applique et fait avancer user_version
    const next = mkdtempSync(join(tmpdir(), 'gb-mig-'));
    copyFileSync(join(MIGRATIONS_DIR, '001_init.sql'), join(next, '001_init.sql'));
    writeFileSync(join(next, '002_essai.sql'), 'CREATE TABLE essai (x INTEGER) STRICT;\n');
    assert.deepEqual(migrate(db, next), ['002_essai.sql']);
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    db.close();
    rmSync(altered, { recursive: true, force: true });
    rmSync(next, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lecture seule : aucune écriture possible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-ro-'));
  try {
    const path = join(dir, 'board.db');
    openJournal(path).close();
    const ro = openJournal(path, { readonly: true });
    assert.throws(() => ro.prepare(`INSERT INTO setting (key, value_json) VALUES ('a', '1')`).run(), /readonly|query_only|read-only/i);
    ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contraintes : clés étrangères, CHECK, UNIQUE, STRICT, JSON', () => {
  const db = openJournal(':memory:');
  const { toolId } = seed(db);
  assert.equal(db.pragma('foreign_key_check').length, 0);
  const rejects = (sql, params, pattern) => assert.throws(() => db.prepare(sql).run(...params), pattern);
  rejects(`INSERT INTO message (conversation_id, seq, role, content) VALUES ('inconnue', 9, 'user', 'x')`, [], /FOREIGN KEY/);
  rejects(`INSERT INTO component (id, kind, name, scope) VALUES ('x1', 'skill', 's', 'workspace')`, [], /CHECK/);
  rejects(`INSERT INTO component (id, kind, name, scope, project_id) VALUES ('x2', 'skill', 's', 'user', ?)`, [P], /CHECK/);
  rejects(`INSERT INTO conversation (id, engine_id, engine_session_id, channel) VALUES ('c2', 'gemini-cli', ?, 'hook')`, [C], /UNIQUE/);
  rejects(`INSERT INTO component (id, kind, name, scope) VALUES ('x3', 'skill', 'agent-tdd-jira', 'user')`, [], /UNIQUE/);
  rejects(`INSERT INTO component_version (component_id, version, status, format, content, sha256) VALUES (?, '2.0.0', 'ratified', 'skill-md', 'x', 'h')`, [SKILL], /CHECK/);
  rejects(`INSERT INTO permission_request (tool_call_id, options_json, decision) VALUES (?, '[]', 'allow_once')`, [toolId], /CHECK/);
  rejects(`INSERT INTO turn (conversation_id, seq) VALUES (?, 'deux')`, [C], /cannot store|datatype/i);
  rejects(`INSERT INTO event (source, direction, type, payload_json) VALUES ('board', 'internal', 'x', '{pas du json')`, [], /CHECK/);
  rejects(`INSERT INTO project (id, slug, name, trusted) VALUES ('p2', 'p2', 'P2', 2)`, [], /CHECK/);
});

test('plein texte : accents ignorés, mises à jour et suppressions suivies', () => {
  const db = openJournal(':memory:');
  seed(db);
  const hits = (table, term) => db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(term).length;
  assert.equal(hits('message_fts', 'developpement'), 1);
  assert.equal(hits('artifact_fts', 'elements'), 1);
  db.prepare(`UPDATE message SET content = 'Texte révisé' WHERE seq = 1 AND conversation_id = ?`).run(C);
  assert.equal(hits('message_fts', 'developpement'), 0);
  assert.equal(hits('message_fts', 'revise'), 1);
  db.prepare(`INSERT INTO project_document (project_id, title, source, content, sha256, size_bytes) VALUES (?, 'Décisions de cadrage', 'upload', 'TOML', 'd', 4)`).run(P);
  assert.equal(hits('document_fts', 'decisions'), 1);
  db.prepare('DELETE FROM conversation WHERE id = ?').run(C);
  assert.equal(hits('message_fts', 'revise'), 0);
});

test('journal en ajout seul : suppression et réécriture refusées, rattachement permis', () => {
  const db = openJournal(':memory:');
  seed(db);
  const id = db.prepare(`INSERT INTO event (source, direction, type, engine_session_id, payload_json) VALUES ('headless', 'in', 'init', ?, '{}')`).run(C).lastInsertRowid;
  assert.throws(() => db.prepare('DELETE FROM event WHERE id = ?').run(id), /ajout seul/);
  assert.throws(() => db.prepare(`UPDATE event SET payload_json = '{"a":1}' WHERE id = ?`).run(id), /modifiables/);
  db.prepare(`UPDATE event SET conversation_id = ?, projected_at = '2026-10-25T10:00:00.000Z', projector_version = 1 WHERE id = ?`).run(C, id);
  db.prepare('DELETE FROM conversation WHERE id = ?').run(C);
  assert.equal(db.prepare('SELECT conversation_id FROM event WHERE id = ?').get(id).conversation_id, null);
});

test('vues : chronologie, synthèse des discussions, version courante des composants', () => {
  const db = openJournal(':memory:');
  seed(db);
  const timeline = db.prepare('SELECT seq, item_type FROM v_timeline WHERE conversation_id = ? ORDER BY seq').all(C);
  assert.deepEqual(timeline.map((t) => `${t.seq}:${t.item_type}`), ['1:message', '2:tool_call', '3:message']);
  const ov = db.prepare('SELECT * FROM v_conversation_overview WHERE id = ?').get(C);
  assert.equal(ov.message_count, 2);
  assert.equal(ov.tool_call_count, 1);
  assert.equal(ov.project_name, 'GeminiBoard');
  const cur = db.prepare('SELECT version, version_status FROM v_component_current WHERE id = ?').get(SKILL);
  assert.deepEqual({ ...cur }, { version: '1.1.0', version_status: 'ratified' });
  assert.equal(db.prepare('SELECT version_id FROM v_component_current WHERE id = ?').get(CMD).version_id, null);
});
