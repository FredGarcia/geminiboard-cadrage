// server.mjs : board-server, seul écrivain de la base (README, §5). API HTTP et WebSocket sur 127.0.0.1 :
// projets, discussions et leur fil, artefacts, composants, journal, recherche ; un tour par prompt (D9).
// Node.js 20 ou plus : fastify 5, @fastify/websocket 11, better-sqlite3 12.9 ; Linux, WSL2 et Windows natif.
// Lancement direct : node packages/server/src/server.mjs (base : ~/.geminiboard/geminiboard.db, port 3210).
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse as parsePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPTURE_POLICIES } from './capture.mjs';
import { openJournal } from './journal.mjs';
import { createProjector } from './projector.mjs';
import { createQueries } from './queries.mjs';
import { createRecorder } from './recorder.mjs';
import { createRedactor } from './redact.mjs';
import { APPROVAL_MODES, resolveGeminiEntry } from './run-gemini.mjs';
import { createTurnManager, MAX_PROMPT_BYTES, TurnError } from './turns.mjs';
import { uuidv7 } from './uuidv7.mjs';

export const DEFAULT_PORT = 3210;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** Dossier du board : GEMINIBOARD_HOME, sinon ~/.geminiboard. */
export const boardHome = (env = process.env) => env.GEMINIBOARD_HOME || join(homedir(), '.geminiboard');

/** Version de Gemini CLI, lue dans le package.json du paquet, sans le lancer. */
export function geminiVersionOf(entry) {
  if (!entry) return null;
  let dir = dirname(entry);
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) continue;
    try { return JSON.parse(readFileSync(file, 'utf8')).version ?? null; } catch { return null; }
  }
  return null;
}

/** config.json du dossier du board (facultatif) : port, maxConcurrentTurns, allowedOrigins, redactionPatterns, maxHeapMb, geminiEntry. */
export function loadConfig(home = boardHome()) {
  const file = join(home, 'config.json');
  if (!existsSync(file)) return {};
  let c;
  try { c = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`config.json illisible : ${e.message}`); }
  const errors = [];
  const check = (key, ok, what) => { if (c[key] !== undefined && !ok(c[key])) errors.push(`${key} : ${what}`); };
  check('port', (v) => Number.isInteger(v) && v > 0 && v < 65536, 'entier entre 1 et 65535');
  check('maxConcurrentTurns', (v) => Number.isInteger(v) && v >= 1 && v <= 8, 'entier entre 1 et 8');
  check('maxHeapMb', (v) => Number.isInteger(v) && v >= 128, 'entier, 128 au moins');
  check('allowedOrigins', (v) => Array.isArray(v) && v.every((o) => typeof o === 'string' && /^https?:\/\/[^/\s]+$/.test(o)), 'liste d\'origines (http://hôte:port)');
  check('redactionPatterns', (v) => Array.isArray(v) && v.every((p) => typeof p === 'string'), 'liste d\'expressions régulières');
  check('geminiEntry', (v) => typeof v === 'string' && isAbsolute(v), 'chemin absolu de gemini.js');
  if (errors.length) throw new Error(`config.json : ${errors.join(' ; ')}`);
  return c;
}

/** Erreur HTTP de l'API : { error: { code, message } }. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Nom d'hôte d'un en-tête Host (« 127.0.0.1:3210 » donne « 127.0.0.1 »). */
const hostnameOf = (host) => {
  const m = String(host ?? '').match(/^\[([^\]]+)\](?::\d+)?$/) ?? String(host ?? '').match(/^([^:]+)(?::\d+)?$/);
  return m ? m[1].toLowerCase() : null;
};

/** Identifiant de projet lisible, sans accents : « Mission Démo » donne « mission-demo ». */
export const slugify = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'projet';

/** Dossier racine d'un projet : absolu, existant, sous sa forme canonique (casse réelle sous Windows). */
function canonicalRoot(input) {
  if (typeof input !== 'string' || !isAbsolute(input)) throw new HttpError(400, 'invalid_path', 'root_path : chemin absolu attendu');
  let real;
  try { real = realpathSync.native(input); } catch { throw new HttpError(400, 'missing_dir', `dossier introuvable : ${input}`); }
  if (!statSync(real).isDirectory()) throw new HttpError(400, 'not_a_directory', `ce n'est pas un dossier : ${input}`);
  if (parsePath(real).root === real) throw new HttpError(400, 'drive_root', 'la racine d\'un lecteur ne peut pas être un projet');
  return real;
}

// Schémas des requêtes (validation par Fastify)
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } };
const text = (max) => ({ type: 'string', maxLength: max });
const projectFields = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: ['string', 'null'], maxLength: 4000 },
  instructions: { type: ['string', 'null'], maxLength: 100000 },
  repo_url: { type: ['string', 'null'], maxLength: 500 },
  capture: { type: 'string', enum: CAPTURE_POLICIES },
  trusted: { type: 'boolean' },
};
const listLimit = (max, def) => ({ type: 'integer', minimum: 1, maximum: max, default: def });

/**
 * Construit le serveur (sans l'écouter). Les migrations s'appliquent à l'ouverture de la base ; les tours
 * restés ouverts après un arrêt brutal sont clos et projetés.
 * @param {object} o
 * @param {string} o.dbPath
 * @param {string|null} [o.entry]            gemini.js ; null : le serveur démarre, mais refuse les prompts
 * @param {number} [o.maxConcurrentTurns]    tours simultanés (1 par défaut : la mémoire du poste est comptée)
 * @param {string[]} [o.allowedOrigins]      origines admises en plus de celles du board (interface en développement)
 * @param {string[]} [o.redactionPatterns]   motifs de secrets en plus des motifs intégrés
 * @param {number} [o.maxHeapMb]             plafond du tas de Gemini CLI
 * @param {Function} [o.run]                 lanceur de Gemini CLI (tests)
 */
export async function buildServer({ dbPath, entry = resolveGeminiEntry(), maxConcurrentTurns = 1, allowedOrigins = [],
  redactionPatterns = [], maxHeapMb, run, logger = false } = {}) {
  const redact = createRedactor(redactionPatterns);
  const db = openJournal(dbPath);
  const rec = createRecorder(db);
  const proj = createProjector(db);
  rec.recoverOpenRuns(); // tours restés ouverts après un arrêt brutal
  proj.projectPending();
  const queries = createQueries(db);
  const engineVersion = geminiVersionOf(entry);
  const turns = createTurnManager({ rec, proj, queries, entry, engineVersion, redact, maxConcurrent: maxConcurrentTurns, maxHeapMb,
    ...(run ? { run } : {}) });

  // removeAdditional: false : un champ inconnu (root_path dans un PATCH…) est refusé, et non ignoré en silence
  const app = Fastify({ logger, bodyLimit: 1024 * 1024, ajv: { customOptions: { removeAdditional: false } } });
  await app.register(websocket, { options: { maxPayload: MAX_PROMPT_BYTES + 1024 * 1024 } });
  app.decorate('turns', turns);
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await turns.closeAll();
    db.close();
  });

  // Hôte et origine : le board ne répond qu'à lui-même. Une page web ouverte dans le navigateur ne peut
  // ni l'appeler (Origin), ni le joindre par un nom de domaine qui pointerait vers 127.0.0.1 (Host).
  app.addHook('onRequest', async (req, reply) => {
    if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) {
      return reply.code(403).send({ error: { code: 'forbidden_host', message: 'hôte refusé : le board ne répond qu\'à 127.0.0.1 et localhost' } });
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const port = req.socket?.localPort;
      const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (![...own, ...allowedOrigins].includes(origin)) {
        return reply.code(403).send({ error: { code: 'forbidden_origin', message: `origine refusée : ${origin}` } });
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err.validation) return reply.code(400).send({ error: { code: 'invalid', message: `requête invalide : ${err.message}` } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: 'invalid', message: err.message } });
    return reply.code(500).send({ error: { code: 'internal', message: `erreur interne : ${err.message}` } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: `introuvable : ${req.method} ${req.url}` } }));

  const notFound = (what) => { throw new HttpError(404, 'not_found', `${what} introuvable`); };

  // --- Santé ------------------------------------------------------------------------------------
  app.get('/api/health', async () => ({
    status: 'ok',
    node: process.version,
    platform: process.platform,
    gemini: { found: Boolean(entry), version: engineVersion },
    turns: { running: turns.running(), limit: turns.limit },
    approvalModes: APPROVAL_MODES,
    capturePolicies: CAPTURE_POLICIES,
    db: { schema: queries.schemaVersion(), ...queries.counts() },
  }));

  // --- Projets ----------------------------------------------------------------------------------
  // Toute modification est un événement project.upsert, qui porte l'état complet du projet
  const upsertProject = (p) => {
    rec.board({ type: 'project.upsert', payload: p });
    proj.projectPending();
    return queries.getProject(p.id);
  };

  app.get('/api/projects', async () => ({ projects: queries.listProjects() }));

  app.post('/api/projects', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'root_path'],
      properties: { ...projectFields, root_path: text(4096), slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 40 } } } },
  }, async (req, reply) => {
    const b = req.body;
    const root = canonicalRoot(b.root_path);
    if (queries.getProjectByRoot(root)) throw new HttpError(409, 'conflict', `un projet a déjà ce dossier : ${root}`);
    let slug = b.slug ?? slugify(b.name);
    if (b.slug && queries.slugTaken(slug)) throw new HttpError(409, 'conflict', `identifiant déjà pris : ${slug}`);
    for (let i = 2; queries.slugTaken(slug); i++) slug = `${slugify(b.name).slice(0, 36)}-${i}`;
    const project = upsertProject({ id: uuidv7(), slug, name: b.name, description: b.description ?? null,
      instructions: b.instructions ?? null, root_path: root, repo_url: b.repo_url ?? null,
      trusted: b.trusted === true, capture: b.capture ?? 'full' });
    return reply.code(201).send({ project });
  });

  app.get('/api/projects/:id', { schema: { params: idParams } }, async (req) =>
    ({ project: queries.getProject(req.params.id) ?? notFound('projet') }));

  // root_path et slug ne changent pas : les discussions et les artefacts y sont rattachés
  app.patch('/api/projects/:id', {
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: projectFields } },
  }, async (req) => {
    const current = queries.getProject(req.params.id) ?? notFound('projet');
    const { conversation_count: _c, last_activity: _l, created_at: _cr, updated_at: _u, archived_at: _a, ...state } = current;
    return { project: upsertProject({ ...state, ...req.body }) };
  });

  // --- Discussions ------------------------------------------------------------------------------
  app.get('/api/conversations', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      project: { type: 'string', pattern: UUID }, before: text(40), limit: listLimit(200, 50) } } },
  }, async (req) => ({
    conversations: queries.listConversations({ projectId: req.query.project ?? null, before: req.query.before ?? null, limit: req.query.limit })
      .map((c) => ({ ...c, running: turns.isRunning(c.id) })),
  }));

  app.get('/api/conversations/:id', { schema: { params: idParams } }, async (req) => {
    const c = queries.getConversation(req.params.id) ?? notFound('discussion');
    return { conversation: { ...c, running: turns.isRunning(c.id) } };
  });

  app.get('/api/conversations/:id/timeline', { schema: { params: idParams } }, async (req) => {
    const c = queries.getConversation(req.params.id) ?? notFound('discussion');
    return { conversation: { ...c, running: turns.isRunning(c.id) }, items: queries.timeline(c.id) };
  });

  app.delete('/api/conversations/:id', { schema: { params: idParams } }, async (req, reply) => {
    const id = req.params.id;
    if (turns.isRunning(id)) throw new HttpError(409, 'busy', 'un tour est en cours dans cette discussion : l\'arrêter d\'abord');
    if (!queries.getConversation(id)) notFound('discussion');
    rec.board({ type: 'conversation.delete', payload: { conversation_id: id } });
    proj.projectPending();
    return reply.code(204).send();
  });

  // --- Artefacts, composants ----------------------------------------------------------------------
  app.get('/api/artifacts', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      project: { type: 'string', pattern: UUID }, conversation: { type: 'string', pattern: UUID }, limit: listLimit(200, 50) } } },
  }, async (req) => ({
    artifacts: queries.listArtifacts({ projectId: req.query.project ?? null, conversationId: req.query.conversation ?? null, limit: req.query.limit }),
  }));

  app.get('/api/artifacts/:id', { schema: { params: idParams } }, async (req) =>
    ({ artifact: queries.getArtifact(req.params.id) ?? notFound('artefact') }));

  app.get('/api/artifacts/:id/versions/:version', {
    schema: { params: { type: 'object', required: ['id', 'version'], properties: {
      id: { type: 'string', pattern: UUID }, version: { type: 'integer', minimum: 1 } } } },
  }, async (req) => ({ version: queries.getArtifactVersion(req.params.id, req.params.version) ?? notFound('version') }));

  app.get('/api/components', async () => ({ components: queries.listComponents() }));

  // --- Journal et recherche ---------------------------------------------------------------------
  app.get('/api/events', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      after: { type: 'integer', minimum: 0, default: 0 }, limit: listLimit(1000, 100),
      source: { type: 'string', enum: ['acp', 'headless', 'hook', 'import', 'pty', 'board'] }, type: text(100),
      session: { type: 'string', pattern: UUID }, conversation: { type: 'string', pattern: UUID } } } },
  }, async (req) => {
    const q = req.query;
    // session : session de Gemini CLI ; conversation : discussion du board (événements des tours projetés)
    const events = queries.listEvents({ after: q.after, limit: q.limit, source: q.source ?? null, type: q.type ?? null,
      session: q.session ?? null, conversation: q.conversation ?? null });
    return { events, next: events.length ? events.at(-1).id : q.after };
  });

  app.get('/api/search', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['q'], properties: {
      q: { type: 'string', minLength: 1, maxLength: 500 }, project: { type: 'string', pattern: UUID }, limit: listLimit(100, 20) } } },
  }, async (req) => queries.search({ text: req.query.q, projectId: req.query.project ?? null, limit: req.query.limit }));

  // --- WebSocket ----------------------------------------------------------------------------------
  // Reçus : { type: 'prompt', requestId?, conversationId?, projectId?, text, approvalMode?, model? }
  //         { type: 'cancel', conversationId? }
  // Émis  : turn.start, event, turn.end, turn.error (avec requestId quand la demande en portait un)
  app.get('/ws', { websocket: true }, (socket) => {
    const mine = new Set(); // discussions dont ce client a lancé le tour en cours
    const send = (msg) => { if (socket.readyState === 1) socket.send(JSON.stringify(msg)); };

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return send({ type: 'turn.error', code: 'invalid', message: 'JSON invalide' }); }
      const requestId = typeof msg?.requestId === 'string' ? msg.requestId.slice(0, 100) : undefined;
      if (msg?.type === 'cancel') {
        const ids = msg.conversationId ? [msg.conversationId].filter((id) => mine.has(id)) : [...mine];
        for (const id of ids) turns.cancel(id);
        return undefined;
      }
      if (msg?.type !== 'prompt') return send({ type: 'turn.error', requestId, code: 'invalid', message: 'type de message inconnu' });
      try {
        const t = turns.start({ conversationId: msg.conversationId, projectId: msg.projectId, text: msg.text,
          approvalMode: msg.approvalMode ?? 'default', model: msg.model }, send);
        mine.add(t.conversationId);
        // Envoyé avant tout événement du tour : ceux-ci n'arrivent qu'au tour suivant de la boucle
        send({ type: 'turn.start', requestId, conversationId: t.conversationId, projectId: t.projectId, runId: t.runId,
          sessionId: t.sessionId, resume: t.resume, capture: t.capture });
        t.finished.finally(() => mine.delete(t.conversationId));
      } catch (e) {
        send({ type: 'turn.error', requestId, conversationId: msg.conversationId ?? null,
          code: e instanceof TurnError ? e.code : 'internal', message: e.message });
      }
      return undefined;
    });

    // Client parti (onglet fermé, réseau coupé) : ses tours en cours sont arrêtés, et l'arrêt journalisé
    socket.on('close', () => { for (const id of mine) turns.cancel(id); });
  });

  return app;
}

/** Démarre le serveur sur 127.0.0.1 avec la configuration du dossier du board. */
export async function startServer({ home = boardHome(), port, log = console.log } = {}) {
  const config = loadConfig(home);
  const dbPath = process.env.GEMINIBOARD_DB || join(home, 'geminiboard.db');
  const entry = config.geminiEntry ?? resolveGeminiEntry();
  const app = await buildServer({
    dbPath, entry, maxConcurrentTurns: config.maxConcurrentTurns ?? 1, allowedOrigins: config.allowedOrigins ?? [],
    redactionPatterns: config.redactionPatterns ?? [], maxHeapMb: config.maxHeapMb,
  });
  const listenPort = port ?? (Number(process.env.GEMINIBOARD_PORT) || config.port || DEFAULT_PORT);
  await app.listen({ host: '127.0.0.1', port: listenPort });
  const actual = app.server.address().port;
  const version = geminiVersionOf(entry);
  log(`GeminiBoard écoute sur http://127.0.0.1:${actual}`);
  log(`  base : ${dbPath}`);
  log(`  Gemini CLI : ${entry ? (version ?? 'version inconnue') : 'introuvable : les prompts seront refusés'} · tours simultanés : ${config.maxConcurrentTurns ?? 1}`);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`Arrêt (${signal}) : tours en cours annulés et journalisés…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  return app;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  startServer().catch((e) => {
    console.error(`GeminiBoard n'a pas démarré : ${e.message}`);
    process.exit(1);
  });
}
