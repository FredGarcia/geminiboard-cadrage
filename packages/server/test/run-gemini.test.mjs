// Tests du lanceur avec un faux Gemini CLI (node --test, Node.js 20 ou plus).
// Le faux CLI est lancé comme gemini.js : avec le node courant, sans shell (Linux et Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGemini, resolveGeminiEntry, EXIT_CODES } from '../src/run-gemini.mjs';
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

test('mémoire : relance de Gemini CLI désactivée par défaut, plafond de tas transmis à node', async () => {
  const { r } = await turn({ prompt: 'x', sessionId: uuidv7(), resume: false, maxHeapMb: 512 });
  assert.ok(r.stderr.includes('relance=non'), r.stderr);
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

test('codes de sortie 42 et 55', async () => {
  assert.equal((await turn({ prompt: 'FAIL42', sessionId: uuidv7(), resume: false })).r.meaning, 'entrée invalide');
  const { r } = await turn({ prompt: 'FAIL55', sessionId: uuidv7(), resume: false });
  assert.equal(r.code, 55);
  assert.equal(r.meaning, EXIT_CODES[55]);
});

test('erreur d\'API : code 144 sans signification, result en erreur', async () => {
  const { events, r } = await turn({ prompt: 'APIERR', sessionId: uuidv7(), resume: false });
  assert.equal(r.code, 144);
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

test('binaire introuvable : ENOENT', async () => {
  const h = runGemini({ prompt: 'x', sessionId: uuidv7(), resume: false, cwd: process.cwd(), bin: './absent', onEvent: () => {} });
  await assert.rejects(h.done, { code: 'ENOENT' });
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
