// helpers.mjs : outils communs aux tests du journal et du projecteur.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openJournal } from '../src/journal.mjs';
import { createRecorder } from '../src/recorder.mjs';
import { createProjector, stableId } from '../src/projector.mjs';

/** Base en mémoire, migrée, avec enregistreur et projecteur. */
export function freshBoard() {
  const db = openJournal(':memory:');
  return { db, rec: createRecorder(db), proj: createProjector(db) };
}

/** Horodatage déterministe : n secondes après une origine fixe. */
export const T = (n) => new Date(Date.UTC(2026, 9, 25, 10, 0, 0) + n * 1000).toISOString();

/** Enregistre un tour complet (prompt, événements stream-json, fin du processus). */
export function recordTurn(rec, { sessionId, runId, prompt, events = [], code = 0, stderr = '', cwd = '/travail/projet',
  approvalMode = 'default', start = 0, snapshots = [], close = true }) {
  rec.start({ runId, sessionId, cwd, args: ['--output-format', 'stream-json'], prompt, approvalMode, startedAt: T(start) });
  events.forEach((ev, i) => {
    const at = T(start + i + 1);
    rec.event({ runId, sessionId, event: { timestamp: at, ...ev }, at });
  });
  for (const s of snapshots) rec.snapshot({ runId, sessionId, at: T(start + events.length + 1), ...s });
  if (close) rec.end({ runId, code, stderr, endedAt: T(start + events.length + 2) });
}

/** Contenu des tables de projection, trié, pour comparer deux états. */
export function projections(db) {
  const tables = {
    conversation: 'id', turn: 'id', message: 'id', tool_call: 'id', artifact: 'id',
    artifact_version: 'id', component_usage: 'id',
  };
  return Object.fromEntries(Object.entries(tables)
    .map(([t, key]) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY ${key}`).all()]));
}

/** Dossier de travail simulé : remplace le masque <WORKSPACE> des fixtures au rechargement. */
export const FIXTURE_WORKSPACE = '/fixtures/workspace';

/** Liste des tours d'une sortie du spike, dans l'ordre des scénarios puis des tours. */
export function spikeTurns(dir) {
  const scenarios = readdirSync(dir).filter((d) => /^S\d+$/.test(d)).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  return scenarios.flatMap((s) => readdirSync(join(dir, s))
    .filter((f) => f.endsWith('.meta.json'))
    .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
    .map((f) => {
      const meta = JSON.parse(readFileSync(join(dir, s, f), 'utf8'));
      const jsonl = join(dir, s, f.replace(/\.meta\.json$/, '.jsonl'));
      const events = existsSync(jsonl)
        ? readFileSync(jsonl, 'utf8').split('\n').filter(Boolean)
          .map((l) => JSON.parse(l.split('<WORKSPACE>').join(FIXTURE_WORKSPACE))) : [];
      return { meta, events };
    }));
}

/** Charge une sortie du spike dans le journal, comme l'aurait fait le serveur. */
export function loadSpikeRun(rec, dir) {
  const turns = spikeTurns(dir);
  turns.forEach(({ meta, events }, i) => {
    const runId = stableId('fixture', basename(dir), meta.scenario, meta.turn);
    const stamps = events.map((e) => e.timestamp).filter((t) => typeof t === 'string');
    const startedAt = stamps[0] ?? T(i * 10);
    rec.start({ runId, sessionId: meta.session.id, cwd: FIXTURE_WORKSPACE, args: meta.argv.slice(1),
      prompt: meta.prompt, approvalMode: meta.approvalMode, resume: meta.session.resume, startedAt });
    for (const ev of events) rec.event({ runId, sessionId: meta.session.id, event: ev, at: ev.timestamp ?? startedAt });
    rec.end({ runId, code: meta.exit.code, stderr: meta.stderrTail ?? '', endedAt: stamps.at(-1) ?? startedAt });
  });
  return turns;
}

/** Dossiers de corpus réels présents dans fixtures/. */
export function realCorpora(root) {
  const dir = join(root, 'fixtures');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => d.startsWith('spike-')).map((d) => join(dir, d))
    .filter((d) => readdirSync(d).some((f) => /^S\d+$/.test(f)));
}
