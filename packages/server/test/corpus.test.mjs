// Rejeu de corpus : chaque sortie du spike est chargée dans le journal, projetée,
// vérifiée tour par tour, puis reconstruite à l'identique (O2).
// - corpus synthétique : produit à la volée par le spike avec le faux Gemini CLI ;
// - corpus réels : tous les dossiers fixtures/spike-* présents dans le dépôt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshBoard, loadSpikeRun, projections, realCorpora } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CAPTURE = join(ROOT, 'spike', 'capture.mjs');
const FAKE = fileURLToPath(new URL('./fake-gemini.mjs', import.meta.url));

function replay(dir) {
  const { db, rec, proj } = freshBoard();
  const turns = loadSpikeRun(rec, dir);
  proj.projectPending();
  const rows = db.prepare(`SELECT t.*, c.id AS session FROM turn t JOIN conversation c ON c.id = t.conversation_id
    JOIN engine_run r ON r.id = t.engine_run_id ORDER BY r.started_at, t.id`).all();
  assert.equal(rows.length, turns.length, 'un tour projeté par tour enregistré');
  assert.equal(db.prepare('SELECT count(*) n FROM event WHERE projected_at IS NULL').get().n, 0);

  for (const { meta, events } of turns) {
    const label = `${meta.scenario} ${meta.turn}`;
    const turn = db.prepare(`SELECT t.* FROM turn t JOIN event e ON e.engine_run_id = t.engine_run_id
      WHERE e.type = 'prompt' AND json_extract(e.payload_json, '$.text') = ? AND t.conversation_id = ?`)
      .all(meta.prompt, meta.session.id);
    assert.ok(turn.length >= 1, `${label} : tour introuvable`);
    const t = turn.at(-1);
    assert.notEqual(t.status, 'running', `${label} : tour clos`);
    const result = events.filter((e) => e.type === 'result').at(-1);
    if (result) assert.equal(t.status, result.status === 'success' ? 'completed' : 'error', `${label} : statut tiré de result`);
    const users = db.prepare(`SELECT content FROM message WHERE turn_id = ? AND role = 'user'`).all(t.id);
    assert.deepEqual(users.map((u) => u.content), [meta.prompt], `${label} : un message utilisateur, le prompt envoyé`);
    const tools = db.prepare('SELECT count(*) n FROM tool_call WHERE turn_id = ?').get(t.id).n;
    assert.equal(tools, events.filter((e) => e.type === 'tool_use').length, `${label} : un appel par tool_use`);
    const text = db.prepare(`SELECT group_concat(content, '' ORDER BY seq) AS t FROM message
      WHERE turn_id = ? AND role = 'assistant'`).get(t.id).t ?? '';
    const expected = events.filter((e) => e.type === 'message' && e.role === 'assistant').map((e) => e.content ?? '').join('');
    assert.equal(text, expected, `${label} : texte de la réponse reconstitué`);
  }

  const before = projections(db);
  proj.rebuild();
  assert.deepEqual(projections(db), before, 'reconstruction à l\'identique');
  return { db, turns };
}

test('corpus synthétique produit par le spike : rejeu complet', () => {
  const out = mkdtempSync(join(tmpdir(), 'gb-corpus-'));
  try {
    const r = spawnSync(process.execPath, [CAPTURE, '--bin', FAKE, '--out', out, '--with-yolo', '--timeout', '20'],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const [run] = readdirSync(out);
    const { db, turns } = replay(join(out, run));
    assert.equal(turns.length, 17);
    // S2 : une seule discussion pour les cinq tours, séquences de tours 1 à 5
    const s2 = turns.find((x) => x.meta.scenario === 'S2').meta.session.id;
    assert.deepEqual(db.prepare('SELECT seq FROM turn WHERE conversation_id = ? ORDER BY seq').all(s2).map((x) => x.seq), [1, 2, 3, 4, 5]);
    // S3 : l'écriture autorisée en auto_edit donne un artefact
    assert.ok(db.prepare(`SELECT count(*) n FROM artifact WHERE path = 'essai-auto-edit.txt'`).get().n >= 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

const corpora = realCorpora(ROOT);
if (corpora.length === 0) {
  test('corpus réels de fixtures/ : rejeu', { skip: 'aucun corpus réel dans fixtures/ (lancer spike/capture.mjs)' }, () => {});
} else {
  for (const dir of corpora) {
    test(`corpus réel ${dir.split(/[\\/]/).at(-1)} : rejeu`, () => { replay(dir); });
  }
}
