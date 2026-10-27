// Serveur du board (src/server.mjs, src/turns.mjs) contre le faux Gemini CLI : API, WebSocket, journal,
// projection, masquage, politiques de capture, sécurité, arrêt et reprise. Node.js 20, Linux et Windows.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { metadataOnly, promptPayload } from '../src/capture.mjs';
import { openJournal } from '../src/journal.mjs';
import { ftsQuery } from '../src/queries.mjs';
import { createRecorder } from '../src/recorder.mjs';
import { createRedactor } from '../src/redact.mjs';
import { runGemini } from '../src/run-gemini.mjs';
import { buildServer, loadConfig, slugify } from '../src/server.mjs';
import { readSnapshot } from '../src/turns.mjs';
import { uuidv7 } from '../src/uuidv7.mjs';

const FAKE = fileURLToPath(new URL('./fake-gemini.mjs', import.meta.url));
const FAKE_KEY = `AI${'za'}${'Q'.repeat(35)}`; // construite par morceaux : verifier.mjs relit aussi ce fichier
const clean = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
// Le faux Gemini CLI tient ses sessions comme la 0.65 : le serveur lui transmet son environnement
process.env.FAKE_GEMINI_STATE = mkdtempSync(join(tmpdir(), 'geminiboard-sessions-'));
after(() => clean(process.env.FAKE_GEMINI_STATE));
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, { timeout = 15000, step = 25, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`délai dépassé : ${what}`);
    await tick(step);
  }
}

/** Serveur sur un port libre, base et projet dans un dossier temporaire. */
async function setup(opts = {}) {
  // Forme canonique, comme la racine d'un projet dans le serveur : sous Windows, le dossier temporaire
  // peut être un nom court (RUNNER~1 en CI, JEANDU~1 sur un poste), que le serveur range sous sa forme longue
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'geminiboard-serveur-')));
  const projectDir = join(dir, 'projet');
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, 'notes.md'), '# titre\n');
  const dbPath = join(dir, 'base', 'geminiboard.db');
  const app = await buildServer({ dbPath, entry: FAKE, ...opts });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const api = async (method, url, payload, headers = {}) => {
    const r = await app.inject({ method, url, payload, headers });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const project = async (fields = {}) => {
    const r = await api('POST', '/api/projects', { name: 'Projet d\'essai', root_path: projectDir, trusted: true, ...fields });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.project;
  };
  const client = () => wsClient(port);
  const close = async () => { await app.close().catch(() => {}); clean(dir); };
  return { dir, projectDir, dbPath, app, port, api, project, client, close };
}

async function wsClient(port, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  await new Promise((ok, ko) => { ws.once('open', ok); ws.once('error', ko); });
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const next = (pred, what) => until(() => inbox.find(pred), { what });
  /** Envoie un prompt ; rend { start, end() } (start : turn.start ou turn.error). */
  const prompt = async (msg) => {
    const requestId = uuidv7();
    ws.send(JSON.stringify({ type: 'prompt', requestId, ...msg }));
    const start = await next((m) => m.requestId === requestId && (m.type === 'turn.start' || m.type === 'turn.error'), 'turn.start');
    const end = () => next((m) => m.conversationId === start.conversationId && m.runId === start.runId
      && (m.type === 'turn.end' || m.type === 'turn.error'), 'turn.end');
    return { start, end, events: () => inbox.filter((m) => m.type === 'event' && m.conversationId === start.conversationId) };
  };
  return { ws, inbox, next, prompt, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

test('unités : masquage des secrets, à toute profondeur, motifs intégrés et configurés', () => {
  const redact = createRedactor(['client-[0-9]{4}']);
  const gh = `gh${'p_'}${'a'.repeat(36)}`;
  const r = redact({ text: `clé ${FAKE_KEY}`, list: [`jeton ${gh}`, 3, null], deep: { h: 'Authorization: Bearer abcdefgh12345678', n: 'client-1234' } });
  assert.equal(r.count, 4);
  assert.equal(r.value.text, 'clé «secret masqué : clé Google»');
  assert.equal(r.value.list[0], 'jeton «secret masqué : jeton GitHub»');
  assert.deepEqual(r.value.list.slice(1), [3, null]);
  assert.equal(r.value.deep.h, 'Authorization: Bearer «secret masqué : autorisation»');
  assert.equal(r.value.deep.n, '«secret masqué : motif configuré»');
  assert.deepEqual(redact('rien à masquer'), { value: 'rien à masquer', count: 0 });
  assert.throws(() => createRedactor(['(']), /motif de masquage invalide/);
  assert.throws(() => createRedactor(['a*']), /chaîne vide/);
});

test('unités : capture metadata, instantanés, identifiants, requête plein texte, config.json', () => {
  assert.deepEqual(metadataOnly({ type: 'message', timestamp: 't', role: 'assistant', content: 'secret', delta: true }),
    { type: 'message', timestamp: 't', capture: 'metadata', role: 'assistant', delta: true, content: '', length: 6 });
  assert.deepEqual(metadataOnly({ type: 'tool_use', tool_name: 'read_file', tool_id: 'x', parameters: { file_path: '/a' } }).parameter_keys, ['file_path']);
  assert.equal(metadataOnly({ type: 'tool_result', tool_id: 'x', status: 'error', output: 'o', error: { type: 'policy', message: 'm' } }).error.message, undefined);
  assert.deepEqual(metadataOnly({ type: 'raw', line: 'ligne' }), { type: 'raw', timestamp: undefined, capture: 'metadata' });
  assert.deepEqual(promptPayload('metadata', { text: 'abc', approvalMode: 'default', resume: false }),
    { text: '', length: 3, approvalMode: 'default', resume: false, capture: 'metadata' });

  const dir = mkdtempSync(join(tmpdir(), 'geminiboard-instantane-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'texte\n');
    writeFileSync(join(dir, 'b.bin'), Buffer.from([1, 0, 2]));
    assert.deepEqual(readSnapshot({ file_path: 'a.txt' }, dir), { path: join(dir, 'a.txt'), content: 'texte\n' });
    assert.equal(readSnapshot({ file_path: join(dir, 'b.bin') }, dir), null, 'binaire');
    assert.equal(readSnapshot({ file_path: 'absent.txt' }, dir), null, 'absent');
    assert.equal(readSnapshot({}, dir), null, 'sans chemin');
    assert.equal(readSnapshot({ file_path: 'a.txt' }, dir, undefined, () => ({ isFile: () => true, size: 2 * 1024 * 1024 })), null, 'trop gros');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 4000, allowedOrigins: ['http://localhost:4200'] }));
    assert.deepEqual(loadConfig(dir), { port: 4000, allowedOrigins: ['http://localhost:4200'] });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 'x', maxConcurrentTurns: 0 }));
    assert.throws(() => loadConfig(dir), /port : entier.*maxConcurrentTurns/);
  } finally { clean(dir); }
  assert.deepEqual(loadConfig(join(tmpdir(), 'geminiboard-absent-')), {});

  assert.equal(slugify('Mission Démo : lot n°2'), 'mission-demo-lot-n-2');
  assert.equal(slugify('***'), 'projet');
  assert.equal(ftsQuery('résumé "piège" OR *'), '"résumé"* "piège"* "OR"* "*"*');
  assert.equal(ftsQuery('   '), '');
});

test('API : santé, projets (validation, conflits, approbation), erreurs en JSON', async () => {
  const s = await setup();
  try {
    const h = await s.api('GET', '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.gemini.found, true);
    assert.deepEqual(h.body.turns, { running: [], limit: 1 });
    assert.equal(h.body.db.schema, 1);

    assert.equal((await s.api('POST', '/api/projects', { name: 'x', root_path: 'relatif' })).body.error.code, 'invalid_path');
    assert.equal((await s.api('POST', '/api/projects', { name: 'x', root_path: join(s.dir, 'absent') })).body.error.code, 'missing_dir');
    assert.equal((await s.api('POST', '/api/projects', { name: 'x', root_path: join(s.projectDir, 'notes.md') })).body.error.code, 'not_a_directory');
    assert.equal((await s.api('POST', '/api/projects', { name: 'x', root_path: process.platform === 'win32' ? 'C:\\' : '/' })).body.error.code, 'drive_root');
    const bad = await s.api('POST', '/api/projects', { name: 'x' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /requête invalide/);

    const created = await s.api('POST', '/api/projects', { name: 'Mission démo', root_path: s.projectDir, capture: 'metadata' });
    assert.equal(created.status, 201);
    const p = created.body.project;
    assert.equal(p.slug, 'mission-demo');
    assert.equal(p.trusted, false, 'un projet n\'est approuvé que sur demande explicite');
    assert.equal(p.capture, 'metadata');
    assert.equal((await s.api('POST', '/api/projects', { name: 'Autre', root_path: join(s.projectDir, '.') })).status, 409, 'même dossier');
    // Une autre écriture du même dossier (lien, ou jonction sans droits d'administrateur sous Windows)
    // se ramène à sa forme canonique : même conflit
    const link = join(s.dir, 'lien');
    symlinkSync(s.projectDir, link, 'junction');
    assert.equal((await s.api('POST', '/api/projects', { name: 'Autre', root_path: link })).status, 409, 'même dossier, par un lien');

    const other = join(s.dir, 'autre');
    mkdirSync(other);
    assert.equal((await s.api('POST', '/api/projects', { name: 'Mission démo', root_path: other })).body.project.slug, 'mission-demo-2');

    const patched = await s.api('PATCH', `/api/projects/${p.id}`, { trusted: true, capture: 'full', instructions: 'Réponds en français.' });
    assert.equal(patched.status, 200);
    assert.deepEqual([patched.body.project.trusted, patched.body.project.capture, patched.body.project.instructions], [true, 'full', 'Réponds en français.']);
    assert.equal(patched.body.project.root_path, p.root_path);
    assert.equal((await s.api('PATCH', `/api/projects/${p.id}`, { root_path: other })).status, 400, 'dossier racine non modifiable');
    assert.equal((await s.api('GET', `/api/projects/${uuidv7()}`)).status, 404);
    assert.equal((await s.api('GET', '/api/projects/pas-un-uuid')).status, 400);
    assert.equal((await s.api('GET', '/api/absent')).body.error.code, 'not_found');
    const list = (await s.api('GET', '/api/projects')).body.projects;
    assert.deepEqual(list.map((x) => x.slug), ['mission-demo', 'mission-demo-2']);

    // Chaque modification est un événement project.upsert, qui porte l'état complet
    const events = (await s.api('GET', '/api/events?type=project.upsert')).body.events;
    assert.equal(events.length, 3);
    assert.equal(events.at(-1).payload.trusted, true);
  } finally { await s.close(); }
});

test('sécurité : hôte et origine étrangers refusés, en HTTP comme en WebSocket ; origine du board admise', async () => {
  const s = await setup({ allowedOrigins: ['http://localhost:4200'] });
  try {
    assert.equal((await s.api('GET', '/api/health', undefined, { host: 'piege.example:3210' })).body.error.code, 'forbidden_host');
    assert.equal((await s.api('GET', '/api/health', undefined, { origin: 'https://site.example' })).body.error.code, 'forbidden_origin');
    assert.equal((await s.api('GET', '/api/health', undefined, { origin: 'http://localhost:4200' })).status, 200);
    const own = await fetch(`http://127.0.0.1:${s.port}/api/health`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
    assert.equal(own.status, 200);
    const foreign = await fetch(`http://127.0.0.1:${s.port}/api/health`, { headers: { origin: 'http://localhost:9999' } });
    assert.equal(foreign.status, 403, 'autre port local');
    await assert.rejects(wsClient(s.port, { origin: 'https://site.example' }), /403/);
    await assert.rejects(wsClient(s.port, { host: `piege.example:${s.port}` }), /403/);
    const ok = await wsClient(s.port, { origin: `http://localhost:${s.port}` });
    ok.close();
  } finally { await s.close(); }
});

test('WebSocket : tour de bout en bout, journal, projection, fil, reprise', async () => {
  const s = await setup();
  try {
    const p = await s.project();
    const c = await s.client();
    const tricky = `--help "guillemets" l'apostrophe $(rm -rf /) ; & | \`ls\`\nnouvelle ligne, accents : éèàç`;
    const t1 = await c.prompt({ projectId: p.id, text: tricky });
    assert.equal(t1.start.type, 'turn.start', JSON.stringify(t1.start));
    assert.equal(t1.start.resume, false);
    assert.equal(t1.start.capture, 'full');
    const e1 = await t1.end();
    assert.deepEqual([e1.type, e1.status, e1.code, e1.inputTokens, e1.outputTokens], ['turn.end', 'completed', 0, 20, 10]);
    const events = t1.events().map((m) => m.event);
    assert.equal(events.length, 8);
    assert.equal(events.find((e) => e.type === 'message' && e.role === 'user').content, tricky, 'prompt intact sur stdin');
    assert.deepEqual(events.map((e) => e.type), ['init', 'message', 'message', 'tool_use', 'tool_result', 'message', 'raw', 'result']);

    const id = t1.start.conversationId;
    const conv = (await s.api('GET', `/api/conversations/${id}`)).body.conversation;
    assert.equal(conv.project_id, p.id);
    assert.equal(conv.turns.length, 1);
    assert.equal(conv.running, false);
    const tl = (await s.api('GET', `/api/conversations/${id}/timeline`)).body.items;
    assert.deepEqual(tl.map((x) => x.kind === 'message' ? x.role : x.tool_name), ['user', 'assistant', 'read_file', 'assistant']);
    assert.equal(tl[0].content, tricky);
    assert.deepEqual(tl[2].input, { file_path: join(s.projectDir, 'notes.md') });

    const t2 = await c.prompt({ conversationId: id, text: 'Deuxième tour', approvalMode: 'plan' });
    assert.equal(t2.start.resume, true, 'session reprise après un tour abouti');
    assert.equal((await t2.end()).status, 'completed');
    assert.equal(t2.start.sessionId, t1.start.sessionId, 'même session de Gemini CLI');
    assert.match(t1.start.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/, 'UUID aléatoire (version 4), pas UUIDv7');
    assert.notEqual(t1.start.sessionId, id, 'discussion et session sont deux identifiants');
    const args = (await s.api('GET', `/api/events?conversation=${id}&type=prompt`)).body.events.map((e) => e.payload);
    assert.deepEqual(args.map((a) => [a.resume, a.approvalMode, a.conversation_id]), [[false, 'default', id], [true, 'plan', id]]);
    const list = (await s.api('GET', `/api/conversations?project=${p.id}`)).body.conversations;
    assert.deepEqual(list.map((x) => [x.id, x.turn_count, x.title]), [[id, 2, '--help "guillemets" l\'apostrophe $(rm -rf /) ; & | `ls`']]);
    c.close();
  } finally { await s.close(); }
});

test('WebSocket : refus sans rien lancer (dossier non approuvé, discussion inconnue, limites, saisie)', async () => {
  const s = await setup({ maxConcurrentTurns: 1 });
  try {
    const untrusted = await s.project({ trusted: false });
    const c = await s.client();
    const refuse = async (msg, code) => {
      const t = await c.prompt(msg);
      assert.equal(t.start.type, 'turn.error', JSON.stringify(t.start));
      assert.equal(t.start.code, code, t.start.message);
      return t.start;
    };
    assert.match((await refuse({ projectId: untrusted.id, text: 'x' }, 'untrusted')).message, /non approuvé/);
    await refuse({ text: 'x' }, 'invalid');
    await refuse({ projectId: untrusted.id, text: '   ' }, 'invalid');
    await refuse({ projectId: untrusted.id, text: 'x', approvalMode: 'tout' }, 'invalid');
    await refuse({ projectId: uuidv7(), text: 'x' }, 'unknown_project');
    await refuse({ conversationId: uuidv7(), text: 'x' }, 'unknown_conversation');
    await refuse({ conversationId: 'pas-un-uuid', text: 'x' }, 'invalid');
    c.send({ type: 'inconnu' });
    await c.next((m) => m.type === 'turn.error' && /inconnu/.test(m.message), 'type inconnu');
    c.ws.send('pas du JSON');
    await c.next((m) => m.type === 'turn.error' && /JSON invalide/.test(m.message), 'JSON invalide');
    assert.equal((await s.api('GET', '/api/events')).body.events.filter((e) => e.source === 'headless').length, 0, 'rien de lancé');

    await s.api('PATCH', `/api/projects/${untrusted.id}`, { trusted: true });
    const long = await c.prompt({ projectId: untrusted.id, text: 'LONG travail' });
    assert.equal(long.start.type, 'turn.start');
    await refuse({ projectId: untrusted.id, text: 'autre' }, 'limit');
    await refuse({ conversationId: long.start.conversationId, text: 'encore' }, 'busy');
    assert.deepEqual((await s.api('GET', '/api/health')).body.turns.running, [long.start.conversationId]);
    c.send({ type: 'cancel', conversationId: long.start.conversationId });
    assert.equal((await long.end()).status, 'cancelled');
    c.close();
  } finally { await s.close(); }
});

test('annulation : demandée, ou client parti ; journalisée par turn.cancel, qui fait foi', async () => {
  const s = await setup({ maxConcurrentTurns: 2 });
  try {
    const p = await s.project();
    const c = await s.client();
    const t = await c.prompt({ projectId: p.id, text: 'LONG travail' });
    await c.next((m) => m.type === 'event' && m.event.type === 'message' && m.event.role === 'user', 'écho du prompt');
    c.send({ type: 'cancel' });
    const end = await t.end();
    assert.deepEqual([end.status, end.meaning], ['cancelled', 'annulation']);

    const c2 = await s.client();
    const t2 = await c2.prompt({ projectId: p.id, text: 'LONG encore' });
    await c2.next((m) => m.type === 'event' && m.event.type === 'init', 'init');
    c2.close(); // onglet fermé
    const id = t2.start.conversationId;
    await until(async () => (await s.api('GET', `/api/conversations/${id}`)).body?.conversation?.turns[0]?.status === 'cancelled',
      { what: 'tour annulé après le départ du client' });
    const cancels = (await s.api('GET', `/api/events?conversation=${id}&type=turn.cancel`)).body.events;
    assert.equal(cancels.length, 1);
    c.close();
  } finally { await s.close(); }
});

test('premier tour en erreur : la discussion ouvre une nouvelle session, la session ratée n\'étant ni reprenable ni recréable', async () => {
  const s = await setup();
  try {
    const p = await s.project();
    const c = await s.client();
    const t1 = await c.prompt({ projectId: p.id, text: 'APIERR dès le départ' });
    const e1 = await t1.end();
    assert.equal(e1.status, 'error');
    assert.equal(e1.code, process.platform === 'win32' ? 400 : 144);
    assert.match(e1.errorMessage, /API Error/);
    const id = t1.start.conversationId;
    // Comme Gemini CLI 0.65 (FAKE_GEMINI_STATE) : --resume ou --session-id de la session ratée sortiraient avec 42
    const t2 = await c.prompt({ conversationId: id, text: 'Nouvel essai' });
    assert.equal(t2.start.conversationId, id, 'même discussion');
    assert.equal(t2.start.resume, false);
    assert.notEqual(t2.start.sessionId, t1.start.sessionId, 'nouvelle session de Gemini CLI');
    const e2 = await t2.end();
    assert.equal(e2.status, 'completed', e2.errorMessage);
    const t3 = await c.prompt({ conversationId: id, text: 'Suite' });
    assert.deepEqual([t3.start.resume, t3.start.sessionId], [true, t2.start.sessionId], 'reprise de la session qui a abouti');
    assert.equal((await t3.end()).status, 'completed');
    const conv = (await s.api('GET', `/api/conversations/${id}`)).body.conversation;
    assert.equal(conv.engine_session_id, t2.start.sessionId);
    assert.deepEqual(conv.turns.map((t) => t.status), ['error', 'completed', 'completed']);
    c.close();
  } finally { await s.close(); }
});

test('artefacts : instantané du fichier écrit, prioritaire sur le contenu de write_file', async () => {
  const s = await setup();
  try {
    const p = await s.project();
    const c = await s.client();
    const t = await c.prompt({ projectId: p.id, text: 'Crée le fichier essai.txt', approvalMode: 'auto_edit' });
    assert.equal((await t.end()).status, 'completed');
    const arts = (await s.api('GET', `/api/artifacts?project=${p.id}`)).body.artifacts;
    assert.deepEqual(arts.map((a) => [a.path, a.version, a.kind]), [['essai.txt', 1, 'document']]);
    const v = (await s.api('GET', `/api/artifacts/${arts[0].id}/versions/1`)).body.version;
    assert.equal(v.content, 'bonjour\n', 'contenu relu sur le disque, et non le paramètre de write_file');
    assert.equal((await s.api('GET', `/api/artifacts/${arts[0].id}`)).body.artifact.versions.length, 1);
    assert.equal((await s.api('GET', `/api/artifacts/${arts[0].id}/versions/2`)).status, 404);
    const snaps = (await s.api('GET', '/api/events?type=artifact.snapshot')).body.events;
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].payload.path, join(s.projectDir, 'essai.txt'));

    // Mode default : écriture refusée, ni fichier ni artefact
    const d = await c.prompt({ conversationId: t.start.conversationId, text: 'Crée le fichier refuse.txt' });
    await d.end();
    assert.equal((await s.api('GET', `/api/artifacts?project=${p.id}`)).body.artifacts.length, 1);
    c.close();
  } finally { await s.close(); }
});

test('masquage : secrets retirés du journal (redacted) et du flux, prompt transmis intact à Gemini CLI', async () => {
  const sent = [];
  const s = await setup({ redactionPatterns: ['CLIENT-[A-Z]{3}'], run: (o) => { sent.push(o.prompt); return runGemini(o); } });
  try {
    const p = await s.project();
    const c = await s.client();
    const text = `Utilise la clé ${FAKE_KEY} pour CLIENT-ABC`;
    const t = await c.prompt({ projectId: p.id, text });
    await t.end();
    assert.deepEqual(sent, [text], 'Gemini CLI reçoit le prompt d\'origine');
    const echo = t.events().find((m) => m.event.type === 'message' && m.event.role === 'user').event.content;
    assert.equal(echo, 'Utilise la clé «secret masqué : clé Google» pour «secret masqué : motif configuré»');
    const journal = (await s.api('GET', `/api/events?conversation=${t.start.conversationId}`)).body.events;
    const prompt = journal.find((e) => e.type === 'prompt');
    assert.equal(prompt.redacted, true);
    assert.equal(prompt.payload.text, echo);
    assert.equal(journal.find((e) => e.type === 'message' && e.payload.role === 'user').redacted, true);
    assert.equal(journal.find((e) => e.type === 'init').redacted, false);
    const raw = s.app.db.prepare('SELECT group_concat(payload_json) AS all_payloads FROM event').get().all_payloads;
    assert.ok(!raw.includes(FAKE_KEY) && !raw.includes('CLIENT-ABC'), 'aucun secret en base');
    const conv = (await s.api('GET', `/api/conversations/${t.start.conversationId}`)).body.conversation;
    assert.ok(!conv.title.includes(FAKE_KEY));
    c.close();
  } finally { await s.close(); }
});

test('capture metadata : forme sans contenu ; capture off : rien en base, reprise en mémoire seulement', async () => {
  const s = await setup({ maxConcurrentTurns: 2 });
  try {
    const meta = await s.project({ capture: 'metadata' });
    const c = await s.client();
    const t = await c.prompt({ projectId: meta.id, text: 'Contenu confidentiel du client' });
    assert.equal(t.start.capture, 'metadata');
    assert.equal((await t.end()).status, 'completed');
    assert.ok(t.events().some((m) => m.event.content === 'Bonjour, '), 'le flux garde le contenu');
    const journal = (await s.api('GET', `/api/events?conversation=${t.start.conversationId}`)).body.events;
    const payloads = JSON.stringify(journal.map((e) => e.payload));
    assert.ok(!payloads.includes('confidentiel') && !payloads.includes('Bonjour') && !payloads.includes('notes.md'), payloads);
    assert.equal(journal.find((e) => e.type === 'prompt').payload.length, 'Contenu confidentiel du client'.length);
    const tl = (await s.api('GET', `/api/conversations/${t.start.conversationId}/timeline`)).body;
    assert.equal(tl.conversation.title, null);
    assert.deepEqual(tl.items.map((x) => x.kind === 'message' ? `${x.role}:${x.content}` : `${x.tool_name}:${x.status}`),
      ['user:', 'assistant:', 'read_file:completed', 'assistant:']);
    assert.equal(tl.conversation.turns[0].input_tokens, 20, 'jetons conservés');

    const offDir = join(s.dir, 'secret');
    mkdirSync(offDir);
    const off = (await s.api('POST', '/api/projects', { name: 'Secret', root_path: offDir, trusted: true, capture: 'off' })).body.project;
    const before = (await s.api('GET', '/api/health')).body.db.events;
    const o1 = await c.prompt({ projectId: off.id, text: 'Rien ne doit rester' });
    assert.equal(o1.start.capture, 'off');
    assert.equal((await o1.end()).status, 'completed');
    const o2 = await c.prompt({ conversationId: o1.start.conversationId, text: 'Suite' });
    assert.equal(o2.start.resume, true, 'session reprise, connue du seul serveur');
    await o2.end();
    assert.equal((await s.api('GET', '/api/health')).body.db.events, before, 'aucun événement journalisé');
    assert.equal((await s.api('GET', `/api/conversations/${o1.start.conversationId}`)).status, 404);
    c.close();

    // Après redémarrage, la discussion « off » n'existe plus
    await s.app.close();
    const again = await buildServer({ dbPath: s.dbPath, entry: FAKE });
    try {
      await again.listen({ host: '127.0.0.1', port: 0 });
      const c2 = await wsClient(again.server.address().port);
      const t3 = await c2.prompt({ conversationId: o1.start.conversationId, text: 'Encore' });
      assert.equal(t3.start.code, 'unknown_conversation');
      c2.close();
    } finally { await again.close(); }
  } finally { await s.close(); }
});

test('recherche sans accents, journal paginé, suppression refusée pendant un tour', async () => {
  const s = await setup();
  try {
    const p = await s.project();
    const c = await s.client();
    const t = await c.prompt({ projectId: p.id, text: 'Résumé élémentaire du projet' });
    await t.end();
    const found = (await s.api('GET', '/api/search?q=resume%20elementaire')).body;
    assert.deepEqual(found.messages.map((m) => [m.conversation_id, m.role]), [[t.start.conversationId, 'user']]);
    assert.match(found.messages[0].snippet, /\[Résumé\] \[élémentaire\]/);
    assert.equal((await s.api('GET', '/api/search?q=%22%20OR%20*%20NEAR(')).status, 200, 'syntaxe FTS5 neutralisée');
    assert.equal((await s.api('GET', '/api/search')).status, 400);

    const page1 = (await s.api('GET', '/api/events?limit=3')).body;
    assert.equal(page1.events.length, 3);
    const page2 = (await s.api('GET', `/api/events?after=${page1.next}&limit=3`)).body;
    assert.ok(page2.events[0].id > page1.events[2].id);
    assert.equal((await s.api('GET', '/api/events?source=nulle')).status, 400);

    const long = await c.prompt({ projectId: p.id, text: 'LONG travail' });
    assert.equal((await s.api('DELETE', `/api/conversations/${long.start.conversationId}`)).status, 409);
    c.send({ type: 'cancel' });
    await long.end();
    assert.equal((await s.api('DELETE', `/api/conversations/${long.start.conversationId}`)).status, 204);
    assert.equal((await s.api('GET', `/api/conversations/${long.start.conversationId}`)).status, 404);
    assert.equal((await s.api('DELETE', `/api/conversations/${long.start.conversationId}`)).status, 404);
    const again = await c.prompt({ conversationId: long.start.conversationId, text: 'revenir ?' });
    assert.equal(again.start.code, 'unknown_conversation');
    assert.match(again.start.message, /supprimée/);
    assert.equal((await s.api('GET', '/api/components')).body.components.length, 0);
    c.close();
  } finally { await s.close(); }
});

test('sans Gemini CLI : le serveur répond, les prompts sont refusés', async () => {
  const s = await setup({ entry: null });
  try {
    assert.deepEqual((await s.api('GET', '/api/health')).body.gemini, { found: false, version: null });
    const p = await s.project();
    const c = await s.client();
    const t = await c.prompt({ projectId: p.id, text: 'Bonjour' });
    assert.equal(t.start.code, 'no_gemini');
    c.close();
  } finally { await s.close(); }
});

test('arrêt du serveur : tours en cours annulés et journalisés ; arrêt brutal : tour clos au démarrage suivant', async () => {
  const s = await setup();
  try {
    const p = await s.project();
    const c = await s.client();
    const t = await c.prompt({ projectId: p.id, text: 'LONG travail' });
    await c.next((m) => m.type === 'event' && m.event.type === 'init', 'init');
    await s.app.close();
    const db = openJournal(s.dbPath, { readonly: true });
    try {
      assert.equal(db.prepare('SELECT status FROM turn WHERE engine_run_id = ?').get(t.start.runId).status, 'cancelled');
      assert.equal(db.prepare("SELECT count(*) AS n FROM event WHERE type = 'turn.cancel'").get().n, 1);
    } finally { db.close(); }

    // Arrêt brutal simulé : un tour reste ouvert dans le journal
    const w = openJournal(s.dbPath);
    const sessionId = uuidv7();
    createRecorder(w).start({ runId: uuidv7(), sessionId, cwd: s.projectDir, prompt: 'interrompu' });
    w.close();
    const again = await buildServer({ dbPath: s.dbPath, entry: FAKE });
    try {
      const r = await again.inject({ method: 'GET', url: `/api/conversations/${sessionId}` });
      assert.equal(JSON.parse(r.body).conversation.turns[0].status, 'cancelled');
    } finally { await again.close(); }
  } finally { await s.close(); }
});
