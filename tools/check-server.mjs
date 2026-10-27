#!/usr/bin/env node
// check-server.mjs : le serveur du board avec le vrai Gemini CLI, sans compte. Une clé d'API invalide suffit :
// Gemini CLI démarre, émet init et l'écho du prompt, puis échoue en 400. Tout se passe dans un dossier
// temporaire (base, projet, GEMINI_CLI_HOME) : la configuration de l'utilisateur n'est pas touchée.
//   1. discussion de bout en bout par le WebSocket : événements relayés, prompt masqué dans le flux ;
//   2. journal et projection : tour en erreur, message d'erreur, version de Gemini CLI, secret masqué ;
//   3. second tour : session recréée (--session-id), car le premier n'a pas abouti ;
//   4. annulation immédiate : tour annulé, arrêt journalisé ;
//   5. client geminiboard (processus réel) : même parcours, code de sortie 1, erreur affichée.
// Node.js 20 ou plus. Usage : node tools/check-server.mjs [--entry <gemini.js>] [--keep]
// Code de sortie : 0 conforme, 1 écart, 2 Gemini CLI introuvable.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { resolveGeminiEntry } from '../packages/server/src/run-gemini.mjs';
import { buildServer, geminiVersionOf } from '../packages/server/src/server.mjs';

const { values: opt } = parseArgs({ options: { entry: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const entry = opt.entry ? resolve(opt.entry) : resolveGeminiEntry();
if (!entry) {
  console.error('Gemini CLI introuvable : « npm install -g @google/gemini-cli », ou --entry <chemin de gemini.js>.');
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'geminiboard-srv-'));
const projectDir = join(base, 'projet');
mkdirSync(join(base, 'home'), { recursive: true });
mkdirSync(projectDir);
writeFileSync(join(projectDir, 'notes.md'), '# Notes\n');
// Le serveur transmet son environnement à Gemini CLI : aucune connexion réelle possible
process.env.GEMINI_CLI_HOME = join(base, 'home');
process.env.GEMINI_API_KEY = 'cle-invalide-pour-la-ci';
for (const k of ['GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_GCA', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS']) delete process.env[k];
const FAKE_KEY = `AI${'za'}${'Z'.repeat(35)}`; // construite par morceaux : verifier.mjs relit ce fichier

const steps = [];
const step = (label, ok, detail = '') => { steps.push({ label, ok: Boolean(ok), detail: String(detail ?? '') }); };
const version = geminiVersionOf(entry);
const apiErrorCode = process.platform === 'win32' ? 400 : 144;
let app;

async function wsClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((ok, ko) => { ws.once('open', ok); ws.once('error', ko); });
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const next = async (pred, ms = 120000) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = inbox.find(pred);
      if (m) return m;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  let n = 0;
  const prompt = async (msg) => {
    const requestId = `r${++n}`;
    ws.send(JSON.stringify({ type: 'prompt', requestId, ...msg }));
    const start = await next((m) => m.requestId === requestId && (m.type === 'turn.start' || m.type === 'turn.error'));
    const end = () => next((m) => m.runId === start?.runId && (m.type === 'turn.end' || m.type === 'turn.error'));
    return { start, end, events: () => inbox.filter((m) => m.type === 'event' && m.conversationId === start?.conversationId) };
  };
  return { ws, prompt, send: (m) => ws.send(JSON.stringify(m)) };
}

try {
  app = await buildServer({ dbPath: join(base, 'geminiboard.db'), entry });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, path, body) => {
    const r = await fetch(url + path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return r.status === 204 ? null : r.json();
  };
  const health = await api('GET', '/api/health');
  step('serveur démarré, Gemini CLI détecté', health.gemini.found && health.gemini.version === version, `version ${health.gemini.version}`);
  const { project } = await api('POST', '/api/projects', { name: 'Contrôle', root_path: projectDir, trusted: true });
  step('projet créé et approuvé', project?.trusted === true, project?.slug);

  // 1. Discussion de bout en bout
  const c = await wsClient(app.server.address().port);
  const t1 = await c.prompt({ projectId: project.id, text: `Résume notes.md ; clé ${FAKE_KEY}` });
  const e1 = await t1.end();
  const types = t1.events().map((m) => m.event.type);
  step('tour relayé : init, écho du prompt, result', types.includes('init') && types.includes('message') && types.includes('result'), types.join(', '));
  const echo = t1.events().find((m) => m.event.type === 'message' && m.event.role === 'user')?.event.content ?? '';
  step('secret masqué dans le flux', echo.includes('«secret masqué : clé Google»') && !echo.includes(FAKE_KEY), echo.slice(0, 80));
  step(`fin du tour : erreur d'API, code ${apiErrorCode}`, e1?.type === 'turn.end' && e1.status === 'error' && e1.code === apiErrorCode,
    `${e1?.status} ${e1?.code} ${String(e1?.errorMessage ?? e1?.message ?? '').slice(0, 100)}`);

  // 2. Journal et projection
  const id = t1.start?.conversationId;
  const { conversation } = await api('GET', `/api/conversations/${id}`);
  step('discussion projetée dans le projet, tour en erreur', conversation?.project_id === project.id && conversation?.turns?.[0]?.status === 'error',
    `${conversation?.turns?.[0]?.status} : ${String(conversation?.turns?.[0]?.error_message ?? '').slice(0, 100)}`);
  const { events } = await api('GET', `/api/events?conversation=${id}&limit=1000`);
  const promptEvent = events.find((e) => e.type === 'prompt');
  step('prompt journalisé masqué (redacted)', promptEvent?.redacted === true && !JSON.stringify(events).includes(FAKE_KEY));
  step('version de Gemini CLI journalisée avec les événements', events.filter((e) => e.source === 'headless').every((e) => e.engine_version === version));

  // 3. Second tour : le premier n'a pas abouti, sa session n'est ni reprenable ni recréable (42) :
  // la discussion en ouvre une nouvelle
  const t2 = await c.prompt({ conversationId: id, text: 'Deuxième essai' });
  const e2 = await t2.end();
  step('second tour : nouvelle session (--session-id), sans sortie 42',
    t2.start?.resume === false && t2.start?.sessionId !== t1.start?.sessionId && e2?.code === apiErrorCode,
    `reprise ${t2.start?.resume}, session ${t2.start?.sessionId === t1.start?.sessionId ? 'identique' : 'nouvelle'}, code ${e2?.code}`);
  const { conversation: after2 } = await api('GET', `/api/conversations/${id}`);
  step('discussion inchangée, deux tours, session suivie', after2?.turns?.length === 2 && after2?.engine_session_id === t2.start?.sessionId);

  // 4. Annulation immédiate
  const t3 = await c.prompt({ projectId: project.id, text: 'À annuler aussitôt' });
  c.send({ type: 'cancel', conversationId: t3.start?.conversationId });
  const e3 = await t3.end();
  const { events: cancels } = await api('GET', `/api/events?conversation=${t3.start?.conversationId}&type=turn.cancel`);
  step('annulation : tour annulé, arrêt journalisé', e3?.status === 'cancelled' && cancels.length === 1, `${e3?.status} ${e3?.code}`);
  c.ws.close();

  // 5. Client en ligne de commande, processus réel
  const cli = spawn(process.execPath, [join(root, 'packages', 'cli', 'src', 'geminiboard.mjs'), 'discuter', '--projet', project.slug, 'Bonjour'], {
    env: { ...process.env, GEMINIBOARD_URL: url }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let err = '';
  cli.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((ok) => cli.on('close', ok));
  step('client geminiboard : erreur d\'API affichée, code de sortie 1', code === 1 && /\[fin\] erreur/.test(err) && /API/.test(err),
    `code ${code} : ${err.split('\n').find((l) => l.startsWith('[fin]')) ?? err.slice(0, 120)}`);
} catch (e) {
  step('contrôle mené à son terme', false, e.stack ?? e.message);
} finally {
  await app?.close().catch(() => {});
}

const ok = steps.every((s) => s.ok);
const mask = (s) => String(s).split(base).join('<TMP>');
const lines = [`Serveur du board · Gemini CLI ${version} · Node.js ${process.version} · ${process.platform}`, ''];
for (const s of steps) lines.push(`${s.ok ? 'OK' : 'KO'}  ${s.label}${s.detail ? ` (${s.detail})` : ''}`);
lines.push('', ok ? 'Serveur conforme.' : 'Écart constaté : voir les lignes KO.');
console.log(mask(lines.join('\n')));
if (process.env.GITHUB_ACTIONS === 'true') { // bilan en annotations, lisible sans les journaux
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const title = `Serveur du board%2C Gemini CLI ${version}%2C ${process.platform}`;
  for (const s of steps.filter((x) => !x.ok)) console.log(`::error title=${title}::${esc(mask(`${s.label} : ${s.detail}`))}`);
  console.log(`::notice title=${title}::${esc(`${steps.filter((x) => x.ok).length} contrôles sur ${steps.length} réussis`)}`);
}
if (opt.keep) console.log(`Dossier conservé : ${base}`);
else {
  try { // sous Windows, un dossier peut rester verrouillé un moment (EBUSY constaté en CI)
    rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (e) {
    console.warn(`Dossier temporaire non supprimé (${e.code ?? e.message}) : ${base}`);
  }
}
process.exit(ok ? 0 : 1);
