// Tests du spike avec le faux Gemini CLI (node --test, Node.js 20 ou plus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CAPTURE = fileURLToPath(new URL('../capture.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('../../packages/server/test/fake-gemini.mjs', import.meta.url));

function capture(args, env = {}) {
  const out = mkdtempSync(join(tmpdir(), 'gb-spike-test-'));
  const r = spawnSync(process.execPath, [CAPTURE, '--bin', FAKE, '--out', out, ...args],
    { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  const [run] = readdirSync(out);
  return { r, out, dir: run ? join(out, run) : null };
}
const read = (dir, ...p) => readFileSync(join(dir, ...p), 'utf8');
const meta = (dir, sc, turn) => JSON.parse(read(dir, sc, `${turn}.meta.json`));

test('parcours complet : fichiers, contrôles S3, reprise S2, masquage', () => {
  const { r, out, dir } = capture(['--with-yolo', '--timeout', '20']);
  try {
    assert.equal(r.status, 0, r.stderr);
    const files = ['S1', 'S2', 'S3', 'S4'].flatMap((s) => readdirSync(join(dir, s)).filter((f) => f.endsWith('.jsonl')));
    assert.equal(files.length, 3 + 5 + 6 + 3, files.join());

    // S3 : le faux CLI applique les règles attendues, les contrôles doivent tous passer
    for (const t of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) assert.equal(meta(dir, 'S3', t).check.ok, true, t);
    assert.ok(meta(dir, 'S3', 'T4').argv.some((a) => a.includes('policy-ls.toml')));

    // S2 : même session, premier tour en --session-id, puis --resume, y compris en parallèle
    const ids = ['T1', 'T2', 'T3a', 'T3b', 'T4'].map((t) => meta(dir, 'S2', t).session);
    assert.equal(new Set(ids.map((s) => s.id)).size, 1);
    assert.deepEqual(ids.map((s) => s.resume), [false, true, true, true, true]);
    assert.ok(meta(dir, 'S2', 'T1').argv.includes('--session-id'));
    assert.ok(meta(dir, 'S2', 'T3b').argv.includes('--resume'));

    // Masquage : ni le dossier de travail ni le dossier personnel n'apparaissent
    const all = ['S1', 'S2', 'S3', 'S4'].flatMap((s) => readdirSync(join(dir, s)).map((f) => read(dir, s, f)))
      .concat(read(dir, 'rapport.md'), read(dir, 'environnement.json')).join('\n');
    assert.ok(all.includes('<WORKSPACE>/notes.md'));
    assert.ok(!all.includes(homedir()));
    assert.ok(!/geminiboard-spike-\w{6}/.test(all));

    // Rapport
    const report = read(dir, 'rapport.md');
    for (const s of ['## S1.', '## S2.', '## S3.', '## S4.', '### Délais mesurés (S4)', '## Synthèse']) assert.ok(report.includes(s), s);
    assert.match(report, /\| T3a \| default \| 0 \(succès\) \|/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('authentification absente : arrêt au premier tour, code 3, rapport écrit', () => {
  const { r, out, dir } = capture(['--only', 'S1'], { FAKE_GEMINI_EXIT: '41' });
  try {
    assert.equal(r.status, 3);
    assert.match(r.stdout, /authentification absente/);
    assert.equal(readdirSync(join(dir, 'S1')).filter((f) => f.endsWith('.jsonl')).length, 1);
    assert.match(read(dir, 'rapport.md'), /Arrêt anticipé/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('délai dépassé : tour annulé, code 130, spike poursuivi', () => {
  const { r, out, dir } = capture(['--only', 'S4', '--timeout', '1'], { FAKE_GEMINI_HANG: '1' });
  try {
    assert.equal(r.status, 0, r.stderr);
    for (const t of ['T1', 'T2', 'T3']) {
      const m = meta(dir, 'S4', t);
      assert.equal(m.exit.timedOut, true);
      assert.equal(m.exit.code, 130);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('erreur d\'API : code 144 lu à travers l\'événement result', () => {
  const { r, out, dir } = capture(['--only', 'S4'], { FAKE_GEMINI_APIERR: '1' });
  try {
    assert.equal(r.status, 0, r.stderr);
    const m = meta(dir, 'S4', 'T1');
    assert.equal(m.exit.code, 144);
    assert.deepEqual(m.exit.result, { status: 'error', error: '[API Error: 400 Bad Request]' });
    const report = read(dir, 'rapport.md');
    assert.match(report, /\| T1 \| default \| 144 \(result : error\) \|/);
    assert.match(report, /Tours terminés par un `result` en erreur : S4 T1, S4 T2, S4 T3/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('Gemini CLI introuvable : code 2 avant toute exécution', () => {
  const out = mkdtempSync(join(tmpdir(), 'gb-spike-test-'));
  try {
    const r = spawnSync(process.execPath, [CAPTURE, '--bin', join(out, 'absent'), '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Gemini CLI introuvable/);
    assert.equal(readdirSync(out).length, 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
