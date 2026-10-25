// Tests du lanceur avec un faux Gemini CLI (node --test, Node.js 20 ou plus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runGemini, EXIT_CODES } from '../src/run-gemini.mjs';
import { uuidv7 } from '../src/uuidv7.mjs';

const FAKE = fileURLToPath(new URL('./fake-gemini.mjs', import.meta.url));

async function turn(opts) {
  const events = [];
  const h = runGemini({ cwd: process.cwd(), bin: FAKE, onEvent: (e) => events.push(e), ...opts });
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

test('annulation en cours de tour : code 130', async () => {
  const h = runGemini({ prompt: 'LONG', sessionId: uuidv7(), resume: false, cwd: process.cwd(), bin: FAKE, onEvent: () => {} });
  setTimeout(() => h.cancel(), 300);
  const r = await h.done;
  assert.equal(r.code, 130);
  assert.equal(r.meaning, 'annulation');
  assert.equal(r.cancelled, true);
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
});
