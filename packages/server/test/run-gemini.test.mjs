// Tests du lanceur avec un faux Gemini CLI (node --test, Node.js 20 ou plus).
// Le faux CLI est lancé comme gemini.js : avec le node courant, sans shell (Linux et Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGemini, resolveGeminiEntry, userPoliciesDir, EXIT_CODES } from '../src/run-gemini.mjs';
import { uuidv7 } from '../src/uuidv7.mjs';

const FAKE = fileURLToPath(new URL('./fake-gemini.mjs', import.meta.url));

async function turn(opts) {
  const events = [];
  const h = runGemini({ cwd: process.cwd(), entry: FAKE, onEvent: (e) => events.push(e), ...opts });
  return { h, events, r: await h.done };
}

test('uuidv7 : format RFC, version 7, tri chronologique', async () => {
  const a = uuidv7();
  await new Promise((r) => setTimeout(r, 2));
  const b = uuidv7();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});

test('premier tour : ordre des événements, ligne coupée, prompt piégé intact', async () => {
  const sid = uuidv7();
  const tricky = `--help "guillemets" l'apostrophe $(rm -rf /) ; & | \`ls\`\nnouvelle ligne, accents : éèàç`;
  const { events, r } = await turn({ prompt: tricky, sessionId: sid, resume: false });
  assert.equal(events.map((e) => e.type).join(), 'init,message,message,tool_use,tool_result,message,raw,result');
  assert.equal(events[2].content, 'Bonjour, ');
  assert.equal(events[1].content, tricky);
  assert.equal(r.code, 0);
  assert.equal(r.meaning, 'succès');
  assert.equal(r.sessionId, sid);
  assert.ok(r.stderr.includes('"--session-id"') && !r.stderr.includes('"--resume"'));
  assert.ok(!r.stderr.includes('guillemets'), 'le prompt ne doit pas apparaître dans argv');
  assert.ok(!r.stderr.includes('--skip-trust'));
});

test('tour suivant : --resume, mode, politique, --skip-trust', async () => {
  const { r } = await turn({ prompt: 'suite', sessionId: uuidv7(), resume: true, approvalMode: 'auto_edit',
    skipTrust: true, policies: ['/tmp/politique.toml'] });
  for (const a of ['"--resume"', '"auto_edit"', '"--skip-trust"', '"--policy","/tmp/politique.toml"']) {
    assert.ok(r.stderr.includes(a), `argument attendu : ${a}`);
  }
});

test('politiques : le dossier de l\'utilisateur reste chargé quand le board ajoute les siennes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gb-home-'));
  try {
    const env = { GEMINI_CLI_HOME: home };
    // Sans dossier de politiques chez l'utilisateur : seules celles du board
    const { r: r1 } = await turn({ prompt: 'x', sessionId: uuidv7(), resume: false, policies: ['/tmp/projet.toml'], env });
    assert.ok(r1.stderr.includes('"--policy","/tmp/projet.toml"') && r1.stderr.split('"--policy"').length === 2, r1.stderr);
    // Avec ~/.gemini/policies : repassé en premier (--policy le remplacerait sinon)
    const dir = join(home, '.gemini', 'policies');
    mkdirSync(dir, { recursive: true });
    const { r: r2 } = await turn({ prompt: 'x', sessionId: uuidv7(), resume: false, policies: ['/tmp/projet.toml'], env });
    assert.ok(r2.stderr.includes(`"--policy",${JSON.stringify(dir)},"--policy","/tmp/projet.toml"`), r2.stderr);
    assert.equal(userPoliciesDir(env), dir);
    // Sans politique du board : rien n'est ajouté, Gemini CLI charge le dossier de lui-même
    const { r: r3 } = await turn({ prompt: 'x', sessionId: uuidv7(), resume: false, env });
    assert.ok(!r3.stderr.includes('--policy'), r3.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('mémoire : relance de Gemini CLI désactivée par défaut, plafond de tas transmis à node', async () => {
  const { r } = await turn({ prompt: 'x', sessionId: uuidv7(), resume: false, maxHeapMb: 512 });
  assert.ok(r.stderr.includes('relance=non'), r.stderr);
  assert.ok(r.stderr.includes('navigateur=non'), r.stderr);
  assert.ok(r.stderr.includes('--max-old-space-size=512'), r.stderr);
  const { r: r2 } = await turn({ prompt: 'x', sessionId: uuidv7(), resume: false, relaunch: true });
  assert.ok(r2.stderr.includes('relance=oui'), r2.stderr);
  assert.ok(r2.stderr.includes('execArgv=[]'), r2.stderr);
});

test('raccourci gemini (mode bin) : même comportement', { skip: process.platform === 'win32' && 'raccourci .cmd sous Windows' }, async () => {
  // Commande sans extension, comme le raccourci installé par npm : lancée directement, sans node ni shell
  const dir = mkdtempSync(join(tmpdir(), 'gb-bin-'));
  const bin = join(dir, 'gemini');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  try {
    const events = [];
    const h = runGemini({ prompt: 'x', sessionId: uuidv7(), resume: false, cwd: process.cwd(), bin, onEvent: (e) => events.push(e) });
    const r = await h.done;
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.includes('relance=non'));
    assert.equal(events[0].type, 'init');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('point d\'entrée relatif : lu depuis le dossier du board, pas depuis celui du projet', async () => {
  const h = runGemini({ prompt: 'x', sessionId: uuidv7(), resume: false, cwd: tmpdir(),
    entry: relative(process.cwd(), FAKE), onEvent: () => {} });
  const r = await h.done;
  assert.equal(r.code, 0, r.stderr);
});

test('connexion Google sans identifiants en cache : code 41, sans question sur stdin (NO_BROWSER)', async () => {
  const { events, r } = await turn({ prompt: 'Bonjour', sessionId: uuidv7(), resume: false, env: { FAKE_GEMINI_LOGIN: '1' } });
  assert.equal(r.code, 41);
  assert.equal(r.meaning, 'authentification');
  assert.deepEqual(events, []);
  // Sans NO_BROWSER, Gemini CLI aurait demandé l'accord d'ouvrir le navigateur et pris le prompt pour la réponse
  const { events: e2, r: r2 } = await turn({ prompt: 'Bonjour', sessionId: uuidv7(), resume: false,
    env: { FAKE_GEMINI_LOGIN: '1', NO_BROWSER: '' } });
  assert.equal(r2.code, 42);
  assert.match(e2[0]?.line ?? '', /Do you want to continue/);
});

test('codes de sortie 42 et 55', async () => {
  assert.equal((await turn({ prompt: 'FAIL42', sessionId: uuidv7(), resume: false })).r.meaning, 'entrée invalide');
  const { r } = await turn({ prompt: 'FAIL55', sessionId: uuidv7(), resume: false });
  assert.equal(r.code, 55);
  assert.equal(r.meaning, EXIT_CODES[55]);
});

test('erreur d\'API : statut HTTP en code de sortie (144, ou 400 sous Windows), result en erreur', async () => {
  const { events, r } = await turn({ prompt: 'APIERR', sessionId: uuidv7(), resume: false });
  assert.equal(r.code, process.platform === 'win32' ? 400 : 144);
  assert.equal(r.meaning, null);
  assert.deepEqual(events.map((e) => e.type), ['init', 'message', 'result']);
  assert.equal(events.at(-1).status, 'error');
});

test('annulation en cours de tour : sens « annulation »', async () => {
  const h = runGemini({ prompt: 'LONG', sessionId: uuidv7(), resume: false, cwd: process.cwd(), entry: FAKE, onEvent: () => {} });
  setTimeout(() => h.cancel(), 300);
  const r = await h.done;
  assert.equal(r.meaning, 'annulation');
  assert.equal(r.cancelled, true);
  if (process.platform !== 'win32') assert.equal(r.code, 130);
});

test('binaire introuvable : ENOENT (sous Windows, le mode bin passe par cmd.exe, qui sort en erreur)', async () => {
  const h = runGemini({ prompt: 'x', sessionId: uuidv7(), resume: false, cwd: process.cwd(), bin: './absent', onEvent: () => {} });
  if (process.platform === 'win32') assert.notEqual((await h.done).code, 0);
  else await assert.rejects(h.done, { code: 'ENOENT' });
});

test('paramètres refusés avant tout lancement', () => {
  const base = { prompt: 'x', resume: false, onEvent() {} };
  assert.throws(() => runGemini({ ...base, sessionId: 'a b' }), /sessionId invalide/);
  assert.throws(() => runGemini({ ...base, sessionId: 'abc', approvalMode: 'tout' }), /inconnu/);
  assert.throws(() => runGemini({ ...base, sessionId: 'abc', model: 'x; rm' }), /modèle invalide/);
  assert.throws(() => runGemini({ ...base, sessionId: 'abc', policies: ['--yolo'] }), /politique invalide/);
  assert.throws(() => runGemini({ ...base, sessionId: 'abc', maxHeapMb: 10 }), /plafond de tas invalide/);
});

test('point d\'entrée : variable GEMINI_CLI_ENTRY, chemin absent', () => {
  assert.equal(resolveGeminiEntry({ env: { GEMINI_CLI_ENTRY: FAKE } }), FAKE);
  assert.equal(resolveGeminiEntry({ env: { GEMINI_CLI_ENTRY: '/chemin/absent/gemini.js' } }), null);
});
