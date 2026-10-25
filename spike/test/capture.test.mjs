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
  const r = spawnSync(process.execPath, [CAPTURE, '--entry', FAKE, '--out', out, ...args],
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
    assert.ok(meta(dir, 'S3', 'T4').argv.some((a) => /^<REPO>[\\/]spike[\\/]policy-ls\.toml$/.test(a)));

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

test('masquage : formes Windows des chemins, nom court, nom d\'utilisateur, clés et adresses', async () => {
  const { createRedactor } = await import('../redact.mjs');
  const shortWs = 'C:\\Users\\JEANDU~1\\AppData\\Local\\Temp\\geminiboard-spike-abc123';
  const longWs = 'C:\\Users\\jean.dupont\\AppData\\Local\\Temp\\geminiboard-spike-abc123';
  const win = createRedactor([[shortWs, '<WORKSPACE>'], [longWs, '<WORKSPACE>'],
    ['C:\\Users\\jean.dupont\\dev\\geminiboard', '<REPO>'], ['C:\\Users\\jean.dupont', '<HOME>']],
  { windows: true, username: 'jean.dupont' });
  const cases = [
    [JSON.stringify({ file_path: `${longWs}\\notes.md` }), '{"file_path":"<WORKSPACE>\\\\notes.md"}'],
    [JSON.stringify({ output: JSON.stringify({ cwd: shortWs }) }), '{"output":"{\\"cwd\\":\\"<WORKSPACE>\\"}"}'],
    ['c:/users/JEAN.DUPONT/AppData/Local/Temp/geminiboard-spike-abc123/src/calc.js', '<WORKSPACE>/src/calc.js'],
    ['--policy C:\\Users\\jean.dupont\\dev\\geminiboard\\spike\\policy-ls.toml', '--policy <REPO>\\spike\\policy-ls.toml'],
    ['C:\\Users\\JEANDU~1\\Desktop\\x.txt et D:\\Users\\autre\\y', '<HOME>\\Desktop\\x.txt et <HOME>\\y'],
    ['Bonjour Jean.Dupont, ton fichier jean.dupontel reste.', 'Bonjour <USER>, ton fichier jean.dupontel reste.'],
    ['jean.dupont@example.com AIza' + 'x'.repeat(35), '<EMAIL> <API_KEY>'],
  ];
  for (const [input, expected] of cases) assert.equal(win(input), expected, input);
  // Hors Windows : comparaison exacte, sensible à la casse
  const posix = createRedactor([['/home/fred', '<HOME>']], { windows: false, username: 'fred' });
  assert.equal(posix('/home/fred/a /home/Fred/b fred'), '<HOME>/a /home/Fred/b <USER>');
});

test('mémoire : pic mesuré par tour (Linux), lecture des formats de tasklist (Windows)', async () => {
  const { parseTasklistKb } = await import('../memory.mjs');
  assert.equal(parseTasklistKb('"node.exe","1234","Console","1","215 432 Ko"'), 215432);
  assert.equal(parseTasklistKb('"node.exe","1234","Console","1","215,432 K"'), 215432);
  assert.equal(parseTasklistKb('INFO: No tasks are running'), 0);
  if (process.platform !== 'linux') return;
  const { r, out, dir } = capture(['--only', 'S4', '--max-heap', '256']);
  try {
    assert.equal(r.status, 0, r.stderr);
    const m = meta(dir, 'S4', 'T1');
    assert.ok(m.memoryPeakMb > 10, `pic mesuré : ${m.memoryPeakMb}`);
    const env = JSON.parse(read(dir, 'environnement.json'));
    assert.deepEqual([env.launch.mode, env.launch.relaunch, env.launch.maxHeapMb], ['node + gemini.js', false, 256]);
    assert.match(read(dir, 'rapport.md'), /Pic de mémoire de Gemini CLI par tour : médiane \d+ Mo/);
    assert.ok(m.stderrTail.includes('relance=non') && m.stderrTail.includes('--max-old-space-size=256'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
