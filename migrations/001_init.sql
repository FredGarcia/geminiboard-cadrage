-- =====================================================================
-- GeminiBoard : schéma SQLite, migration 001_init
--
-- Fichier unique, mode WAL, un seul écrivain : le serveur du board.
-- Le serveur pose à chaque connexion : journal_mode=WAL, foreign_keys=ON,
-- busy_timeout=5000, synchronous=NORMAL. Le lanceur de migrations
-- (packages/server/src/journal.mjs) exécute ce script dans une transaction,
-- puis inscrit la version et l'empreinte sha256 dans schema_migration et
-- dans PRAGMA user_version. Une migration appliquée ne se modifie plus :
-- toute évolution passe par un nouveau fichier 002_*.sql.
--
-- Conventions
--   horodatages : TEXT ISO 8601 UTC à la milliseconde
--   JSON        : TEXT contrôlé par json_valid()
--   booléens    : INTEGER 0/1
--   clés        : TEXT UUIDv7 pour les entités exposées (URL, API, MCP),
--                 INTEGER pour les tables à fort volume (rowid stable,
--                 indispensable aux index plein texte)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Méta
-- ---------------------------------------------------------------------
CREATE TABLE schema_migration (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  checksum    TEXT    NOT NULL,                       -- sha256 du script appliqué
  applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE setting (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- ---------------------------------------------------------------------
-- 1. Moteurs et exécutions
-- ---------------------------------------------------------------------
CREATE TABLE engine (
  id           TEXT PRIMARY KEY,                      -- 'gemini-cli' | 'claude-code'
  label        TEXT NOT NULL,
  command      TEXT NOT NULL,                         -- binaire lancé par le board
  version      TEXT,                                  -- dernière version détectée
  detected_at  TEXT
) STRICT;

INSERT INTO engine (id, label, command) VALUES
  ('gemini-cli',  'Gemini CLI',            'gemini'),
  ('claude-code', 'Claude Code (via ACP)', 'claude-agent-acp');

CREATE TABLE engine_run (                             -- un processus moteur lancé par le board
  id              TEXT PRIMARY KEY,                   -- UUIDv7
  engine_id       TEXT NOT NULL REFERENCES engine(id),
  engine_version  TEXT,
  channel         TEXT NOT NULL CHECK (channel IN ('acp','headless','pty')),
  argv_json       TEXT NOT NULL CHECK (json_valid(argv_json)),
  cwd             TEXT NOT NULL,
  pid             INTEGER,
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at        TEXT,
  exit_code       INTEGER,                            -- headless : 0, 1, 42, 53
  stderr_tail     TEXT                                -- fin de stderr, pour le diagnostic
) STRICT;

-- ---------------------------------------------------------------------
-- 2. Projets
-- ---------------------------------------------------------------------
CREATE TABLE project (
  id                   TEXT PRIMARY KEY,              -- UUIDv7
  slug                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  description          TEXT,
  instructions         TEXT,                          -- instructions du projet, injectées à chaque session
  root_path            TEXT UNIQUE,                   -- dossier racine (cwd des sessions)
  gemini_project_hash  TEXT,                          -- clé du dossier ~/.gemini/tmp/<hash>/
  repo_url             TEXT,
  trusted              INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0,1)),  -- dossier approuvé par l'humain (--skip-trust)
  capture              TEXT NOT NULL DEFAULT 'full'
                       CHECK (capture IN ('full','metadata','off')),  -- politique de capture du projet
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at          TEXT
) STRICT;

CREATE TABLE project_document (                       -- connaissances du projet
  id           INTEGER PRIMARY KEY,
  project_id   TEXT    NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  source       TEXT    NOT NULL CHECK (source IN ('upload','path','url','artifact')),
  location     TEXT,                                  -- chemin, URL ou identifiant d'artefact
  mime         TEXT    NOT NULL DEFAULT 'text/markdown',
  content      TEXT,                                  -- texte indexé (NULL si binaire)
  blob_sha256  TEXT,                                  -- binaire rangé dans blobs/<sha256>
  sha256       TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (content IS NOT NULL OR blob_sha256 IS NOT NULL)
) STRICT;
CREATE INDEX ix_project_document_project ON project_document(project_id);

-- ---------------------------------------------------------------------
-- 3. Catalogue : skills, sous-agents, commandes, hooks, serveurs MCP,
--    outils, extensions, fichiers de contexte, politiques
-- ---------------------------------------------------------------------
CREATE TABLE component (
  id             TEXT PRIMARY KEY,                    -- UUIDv7
  kind           TEXT NOT NULL CHECK (kind IN ('skill','agent','command','hook','mcp_server',
                                               'tool','extension','context_file','policy')),
  name           TEXT NOT NULL,                       -- 'agent-tdd-jira', 'git:commit', 'frontend-specialist'
  scope          TEXT NOT NULL CHECK (scope IN ('builtin','extension','user','workspace','board')),
  project_id     TEXT REFERENCES project(id) ON DELETE CASCADE,     -- renseigné pour le scope workspace
  parent_id      TEXT REFERENCES component(id) ON DELETE CASCADE,   -- extension -> composants ; serveur MCP -> outils
  description    TEXT,
  source_repo    TEXT,                                -- 'FredGarcia/Agent2Prompt'
  source_path    TEXT,                                -- chemin dans le dépôt ou sur disque
  targets        TEXT NOT NULL DEFAULT 'gemini' CHECK (targets IN ('gemini','claude','both')),
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  meta_json      TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)),
  discovered_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((scope = 'workspace') = (project_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ux_component_identity
  ON component(kind, scope, ifnull(project_id, ''), ifnull(parent_id, ''), name);
CREATE INDEX ix_component_parent ON component(parent_id);

CREATE TABLE component_version (
  id            INTEGER PRIMARY KEY,
  component_id  TEXT    NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  version       TEXT    NOT NULL,                     -- semver
  status        TEXT    NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','proposed','ratified','deprecated')),
  format        TEXT    NOT NULL CHECK (format IN ('skill-md','command-toml','command-md','agent-md',
                                                   'hooks-json','extension-json','plugin-json',
                                                   'mcp-json','context-md','policy-toml','other')),
  content       TEXT    NOT NULL,                     -- manifeste principal (SKILL.md, .toml, .md d'agent)
  files_json    TEXT    CHECK (files_json IS NULL OR json_valid(files_json)),  -- [{path, sha256, size}]
  sha256        TEXT    NOT NULL,                     -- empreinte de l'arborescence complète
  git_ref       TEXT,                                 -- commit ou tag d'origine
  pr_url        TEXT,                                 -- PR de ratification
  ratified_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (component_id, version),
  CHECK (status <> 'ratified' OR ratified_at IS NOT NULL)
) STRICT;

CREATE TABLE project_component (                      -- composants activés pour un projet
  project_id         TEXT    NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  component_id       TEXT    NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  pinned_version_id  INTEGER REFERENCES component_version(id) ON DELETE SET NULL,
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  PRIMARY KEY (project_id, component_id)
) STRICT;

-- ---------------------------------------------------------------------
-- 4. Discussions
-- ---------------------------------------------------------------------
CREATE TABLE conversation (
  id                 TEXT PRIMARY KEY,                -- UUIDv7, visible dans l'URL /chat/<id>
  project_id         TEXT REFERENCES project(id) ON DELETE SET NULL,
  engine_id          TEXT NOT NULL REFERENCES engine(id),
  engine_session_id  TEXT,                            -- UUID de session du moteur
  channel            TEXT NOT NULL CHECK (channel IN ('acp','headless','hook','import','pty')),
  title              TEXT,
  cwd                TEXT,
  model              TEXT,
  approval_mode      TEXT,                            -- Gemini : default | auto_edit | yolo | plan
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','idle','ended','archived','error')),
  parent_id          TEXT REFERENCES conversation(id) ON DELETE SET NULL,  -- reprise ou bifurcation
  starred            INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  summary            TEXT,
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at           TEXT
) STRICT;
-- Une session moteur = une discussion, quel que soit le canal qui l'a vue
CREATE UNIQUE INDEX ux_conversation_engine_session
  ON conversation(engine_id, engine_session_id) WHERE engine_session_id IS NOT NULL;
CREATE INDEX ix_conversation_recent  ON conversation(updated_at);
CREATE INDEX ix_conversation_project ON conversation(project_id, updated_at);

CREATE TABLE turn (                                   -- un prompt et tout ce qu'il déclenche
  id               INTEGER PRIMARY KEY,
  conversation_id  TEXT    NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,                  -- 1, 2, 3... dans la discussion
  engine_run_id    TEXT    REFERENCES engine_run(id) ON DELETE SET NULL,
  command_name     TEXT,                              -- '/git:commit' si le tour part d'une commande
  status           TEXT    NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','completed','cancelled','refused','limit','error')),
  stop_reason      TEXT,                              -- end_turn, max_tokens, max_turn_requests, refusal, cancelled, code de sortie
  error_message    TEXT,                              -- message de result en erreur, ou fin de stderr
  model            TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cached_tokens    INTEGER,
  thought_tokens   INTEGER,
  stats_json       TEXT    CHECK (stats_json IS NULL OR json_valid(stats_json)),
  started_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at         TEXT,
  duration_ms      INTEGER,
  UNIQUE (conversation_id, seq)
) STRICT;

CREATE TABLE message (
  id                INTEGER PRIMARY KEY,              -- rowid stable : clé de message_fts
  conversation_id   TEXT    NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  turn_id           INTEGER REFERENCES turn(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,                 -- position dans la chronologie, partagée avec tool_call
  role              TEXT    NOT NULL CHECK (role IN ('user','assistant','thought','system')),
  content           TEXT    NOT NULL,
  content_format    TEXT    NOT NULL DEFAULT 'markdown' CHECK (content_format IN ('markdown','text','json')),
  attachments_json  TEXT    CHECK (attachments_json IS NULL OR json_valid(attachments_json)),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at      TEXT,
  UNIQUE (conversation_id, seq)
) STRICT;
CREATE INDEX ix_message_turn ON message(turn_id);

CREATE TABLE tool_call (
  id               INTEGER PRIMARY KEY,
  conversation_id  TEXT    NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  turn_id          INTEGER REFERENCES turn(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,                  -- même séquence que message
  engine_call_id   TEXT,                              -- toolCallId (ACP) ou identifiant stream-json
  tool_name        TEXT    NOT NULL,                  -- read_file, run_shell_command, activate_skill, outil MCP...
  tool_kind        TEXT    NOT NULL DEFAULT 'other'
                   CHECK (tool_kind IN ('read','edit','delete','move','search','execute',
                                        'think','fetch','skill','agent','mcp','other')),
  component_id     TEXT    REFERENCES component(id) ON DELETE SET NULL,  -- skill, sous-agent ou serveur MCP concerné
  title            TEXT,
  input_json       TEXT    CHECK (input_json IS NULL OR json_valid(input_json)),
  output_text      TEXT,
  locations_json   TEXT    CHECK (locations_json IS NULL OR json_valid(locations_json)),  -- fichiers touchés
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','awaiting_permission','in_progress',
                                     'completed','failed','denied','cancelled')),
  error_message    TEXT,
  started_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at         TEXT,
  duration_ms      INTEGER,
  UNIQUE (conversation_id, seq)
) STRICT;
-- Unicité par tour : chaque tour headless est un nouveau processus, dont les identifiants
-- d'appel ne sont pas garantis uniques sur toute la discussion
CREATE UNIQUE INDEX ux_tool_call_engine
  ON tool_call(turn_id, engine_call_id) WHERE engine_call_id IS NOT NULL;
CREATE INDEX ix_tool_call_turn ON tool_call(turn_id);
CREATE INDEX ix_tool_call_name ON tool_call(tool_name);

CREATE TABLE permission_request (                     -- demandes d'autorisation et décisions
  id            INTEGER PRIMARY KEY,
  tool_call_id  INTEGER NOT NULL REFERENCES tool_call(id) ON DELETE CASCADE,
  options_json  TEXT    NOT NULL CHECK (json_valid(options_json)),  -- options proposées par le moteur
  decision      TEXT    CHECK (decision IN ('allow_once','allow_always','reject_once',
                                            'reject_always','cancelled','timeout')),
  decided_by    TEXT    CHECK (decided_by IN ('human','policy','hook','auto')),
  reason        TEXT,
  requested_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at    TEXT,
  CHECK ((decision IS NULL) = (decided_at IS NULL))
) STRICT;
CREATE INDEX ix_permission_tool_call ON permission_request(tool_call_id);

-- ---------------------------------------------------------------------
-- 5. Artefacts
-- ---------------------------------------------------------------------
CREATE TABLE artifact (
  id               TEXT PRIMARY KEY,                  -- UUIDv7
  project_id       TEXT REFERENCES project(id) ON DELETE SET NULL,
  conversation_id  TEXT REFERENCES conversation(id) ON DELETE SET NULL,  -- discussion d'origine
  kind             TEXT NOT NULL CHECK (kind IN ('document','code','html','diagram','data','image','file')),
  title            TEXT NOT NULL,
  path             TEXT,                              -- fichier correspondant dans l'espace de travail
  language         TEXT,                              -- typescript, java, sql, toml, mermaid...
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX ix_artifact_project ON artifact(project_id, updated_at);
CREATE INDEX ix_artifact_conversation ON artifact(conversation_id);
CREATE UNIQUE INDEX ux_artifact_path ON artifact(project_id, path) WHERE path IS NOT NULL;

CREATE TABLE artifact_version (
  id            INTEGER PRIMARY KEY,                  -- rowid stable : clé de artifact_fts
  artifact_id   TEXT    NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  content       TEXT,                                 -- texte (NULL si binaire)
  blob_sha256   TEXT,
  mime          TEXT    NOT NULL,
  sha256        TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  origin        TEXT    NOT NULL CHECK (origin IN ('agent','human','import')),
  message_id    INTEGER REFERENCES message(id) ON DELETE SET NULL,
  tool_call_id  INTEGER REFERENCES tool_call(id) ON DELETE SET NULL,  -- write_file ou replace qui l'a produite
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, version),
  CHECK (content IS NOT NULL OR blob_sha256 IS NOT NULL)
) STRICT;

-- ---------------------------------------------------------------------
-- 6. Usages des composants (traçabilité : quelle version a servi où)
-- ---------------------------------------------------------------------
CREATE TABLE component_usage (
  id                    INTEGER PRIMARY KEY,
  conversation_id       TEXT    NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  turn_id               INTEGER REFERENCES turn(id) ON DELETE CASCADE,
  component_id          TEXT    NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  component_version_id  INTEGER REFERENCES component_version(id) ON DELETE SET NULL,
  usage                 TEXT    NOT NULL CHECK (usage IN ('activated','invoked','delegated','fired','blocked')),
  tool_call_id          INTEGER REFERENCES tool_call(id) ON DELETE SET NULL,
  at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX ix_usage_conversation ON component_usage(conversation_id);
CREATE INDEX ix_usage_component ON component_usage(component_id, at);

-- ---------------------------------------------------------------------
-- 7. Journal brut : seule source de vérité, en ajout seul
-- ---------------------------------------------------------------------
CREATE TABLE event (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,   -- ordre total, jamais réutilisé
  received_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source             TEXT    NOT NULL CHECK (source IN ('acp','headless','hook','import','pty','board')),
  direction          TEXT    NOT NULL CHECK (direction IN ('in','out','internal')),
                             -- in : moteur -> board ; out : board -> moteur ; internal : action de gestion
  type               TEXT    NOT NULL,                -- 'session/update', 'tool_use', 'BeforeTool', 'project.created'
  engine_id          TEXT    REFERENCES engine(id),
  engine_version     TEXT,
  engine_run_id      TEXT    REFERENCES engine_run(id) ON DELETE SET NULL,
  engine_session_id  TEXT,                            -- clé de rattachement, connue avant la discussion
  conversation_id    TEXT    REFERENCES conversation(id) ON DELETE SET NULL,
  payload_json       TEXT    NOT NULL CHECK (json_valid(payload_json)),
  redacted           INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0,1)),  -- masquage appliqué avant écriture
  projected_at       TEXT,                            -- NULL tant que le projecteur ne l'a pas traité
  projector_version  INTEGER
) STRICT;
CREATE INDEX ix_event_conversation ON event(conversation_id, id);
CREATE INDEX ix_event_session ON event(engine_session_id, id) WHERE engine_session_id IS NOT NULL;
CREATE INDEX ix_event_pending ON event(id) WHERE projected_at IS NULL;

CREATE TRIGGER trg_event_no_delete BEFORE DELETE ON event
BEGIN
  SELECT RAISE(ABORT, 'event : journal en ajout seul');
END;

CREATE TRIGGER trg_event_immutable
BEFORE UPDATE OF received_at, source, direction, type, engine_id, engine_version,
                 engine_session_id, payload_json, redacted ON event
BEGIN
  SELECT RAISE(ABORT, 'event : seules les colonnes de rattachement et de projection sont modifiables');
END;

-- ---------------------------------------------------------------------
-- 8. Retours (boucle de second ordre : l'observateur est journalisé)
-- ---------------------------------------------------------------------
CREATE TABLE feedback (
  id           INTEGER PRIMARY KEY,
  target_type  TEXT    NOT NULL CHECK (target_type IN ('message','tool_call','turn',
                                                       'artifact_version','component_version')),
  target_id    TEXT    NOT NULL,                      -- clé de la cible, polymorphe donc sans FK
  rating       INTEGER CHECK (rating IN (-1,0,1)),
  comment      TEXT,
  author       TEXT    NOT NULL DEFAULT 'human',      -- 'human', 'claude', 'gemini' ou nom d'agent
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (rating IS NOT NULL OR comment IS NOT NULL)
) STRICT;
CREATE INDEX ix_feedback_target ON feedback(target_type, target_id);

-- ---------------------------------------------------------------------
-- 9. Recherche plein texte (accents ignorés)
-- ---------------------------------------------------------------------
CREATE VIRTUAL TABLE message_fts USING fts5(
  content, content='message', content_rowid='id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER trg_message_fts_insert AFTER INSERT ON message BEGIN
  INSERT INTO message_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER trg_message_fts_delete AFTER DELETE ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER trg_message_fts_update AFTER UPDATE OF content ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO message_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE VIRTUAL TABLE artifact_fts USING fts5(
  content, content='artifact_version', content_rowid='id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER trg_artifact_fts_insert AFTER INSERT ON artifact_version BEGIN
  INSERT INTO artifact_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER trg_artifact_fts_delete AFTER DELETE ON artifact_version BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER trg_artifact_fts_update AFTER UPDATE OF content ON artifact_version BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO artifact_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE VIRTUAL TABLE document_fts USING fts5(
  title, content, content='project_document', content_rowid='id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER trg_document_fts_insert AFTER INSERT ON project_document BEGIN
  INSERT INTO document_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER trg_document_fts_delete AFTER DELETE ON project_document BEGIN
  INSERT INTO document_fts(document_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER trg_document_fts_update AFTER UPDATE OF title, content ON project_document BEGIN
  INSERT INTO document_fts(document_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO document_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

-- La barre latérale trie les discussions par dernière activité
CREATE TRIGGER trg_message_touch_conversation AFTER INSERT ON message BEGIN
  UPDATE conversation SET updated_at = new.created_at WHERE id = new.conversation_id;
END;

-- ---------------------------------------------------------------------
-- 10. Vues : contrat de lecture stable (interface, MCP, Claude)
-- ---------------------------------------------------------------------
CREATE VIEW v_timeline AS                             -- à lire avec ORDER BY seq
SELECT m.conversation_id, m.seq, 'message' AS item_type, m.id AS item_id,
       m.role AS label, m.content AS body, m.created_at AS at
FROM message m
UNION ALL
SELECT t.conversation_id, t.seq, 'tool_call', t.id,
       t.tool_name || ' [' || t.status || ']',
       coalesce(t.title, t.input_json, ''), t.started_at
FROM tool_call t;

CREATE VIEW v_conversation_overview AS
SELECT c.id, c.title, c.engine_id, c.channel, c.status, c.starred,
       p.name AS project_name, c.started_at, c.updated_at,
       (SELECT count(*) FROM message m   WHERE m.conversation_id = c.id) AS message_count,
       (SELECT count(*) FROM tool_call t WHERE t.conversation_id = c.id) AS tool_call_count,
       (SELECT sum(coalesce(u.input_tokens, 0) + coalesce(u.output_tokens, 0))
          FROM turn u WHERE u.conversation_id = c.id) AS total_tokens
FROM conversation c
LEFT JOIN project p ON p.id = c.project_id;

CREATE VIEW v_component_current AS                    -- dernière version ratifiée, à défaut la plus récente
SELECT c.id, c.kind, c.name, c.scope, c.project_id, c.targets, c.enabled,
       c.source_repo, c.source_path,
       v.id AS version_id, v.version, v.status AS version_status, v.ratified_at, v.pr_url
FROM component c
LEFT JOIN component_version v ON v.id = (
  SELECT x.id FROM component_version x
  WHERE x.component_id = c.id
  ORDER BY (x.status = 'ratified') DESC, x.created_at DESC, x.id DESC
  LIMIT 1
);
