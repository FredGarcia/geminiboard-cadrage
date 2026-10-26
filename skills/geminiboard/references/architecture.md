# Architecture du dépôt

État à l'étape 3 (octobre 2026). Le cadrage complet est au README, §5 à §9 ; cette fiche dit où se trouve quoi et où ajouter quoi.

## Vue d'ensemble

- **`board-server`** : seul écrivain de la base. À chaque prompt, il lance un processus Gemini CLI en headless (D9), journalise chaque événement, le relaie à l'interface, puis projette le tour clos. API HTTP et WebSocket à l'étape 4.
- **Gemini CLI** : un processus par prompt, `--output-format stream-json`, prompt écrit sur l'entrée standard ; `--session-id <uuid>` au premier tour, `--resume <uuid>` ensuite, une fois qu'un tour a abouti.
- **Base SQLite** unique (`~/.geminiboard/geminiboard.db`), mode WAL. Le journal brut `event` est en ajout seul ; les autres tables sont des projections, reconstructibles par rejeu (O2).
- **Lecture par Claude** (étape 7) : serveur MCP en lecture seule, ou fichier joint ; les vues `v_*` forment le contrat de lecture.
- **Interface** Angular au style de Claude (étape 5).

## Carte du code

| Chemin | Contenu |
|---|---|
| `packages/server/src/run-gemini.mjs` | lanceur d'un tour : `runGemini`, `resolveGeminiEntry`, `userPoliciesDir`, `APPROVAL_MODES`, `EXIT_CODES` |
| `packages/server/src/journal.mjs` | `openJournal` (pragmas du board, ou lecture seule avec `query_only`), `migrate` (empreintes sha256, fins de ligne ignorées) |
| `packages/server/src/recorder.mjs` | `createRecorder` : unique point d'écriture du journal (`engine_run`, `event`) |
| `packages/server/src/projector.mjs` | `createProjector`, `PROJECTOR_VERSION`, et les aides `inside`, `stableId`, `toolKind` |
| `packages/server/src/uuidv7.mjs` | identifiants UUIDv7 |
| `packages/server/test/` | tests du serveur ; faux Gemini CLI `packages/server/test/fake-gemini.mjs` ; aides `packages/server/test/helpers.mjs` |
| `migrations/001_init.sql` | schéma v1 : tables `STRICT`, triggers du journal, index plein texte, vues `v_*` |
| `spike/` | spike de capture S1 à S4 (`spike/capture.mjs`, avec `spike/scenarios.mjs`, `spike/redact.mjs`, `spike/memory.mjs`) et S5 (`spike/catalogue.mjs`) |
| `fixtures/` | corpus produits par le spike, rejoués par les tests ; `fixtures/README.md` en donne le format |
| `tools/` | `tools/run-tests.mjs` ; contrôles des composants `tools/check-components.mjs` et `tools/check-extension.mjs` ; outils de la CI `tools/ci-run.mjs`, `tools/ci-annotations.mjs`, `tools/ci-spike-check.mjs` |
| `skills/`, `commands/`, `agents/` | composants portables (D12) ; avec `gemini-extension.json` et `AGENTS.md` à la racine, le dépôt est une extension Gemini CLI |
| `.github/workflows/` | CI : `.github/workflows/tests.yml` (tests) et `.github/workflows/gemini-cli.yml` (vrai Gemini CLI) |

Paquets prévus au README, §5.2 (à venir) : `packages/ui` à l'étape 5, `packages/hook` à l'étape 6, `packages/mcp` à l'étape 7, `packages/cli` au fil des étapes. L'esquisse du serveur (`server.mjs`) est au README, §6.3 ; elle entre dans `packages/server/src` à l'étape 4.

## Un tour, de bout en bout

1. Le serveur choisit l'identifiant de session (UUIDv7) ; il reprend la session (`resume`) seulement si un `result` en succès existe déjà pour elle dans le journal, sinon Gemini CLI sortirait avec le code 42.
2. `runGemini({ prompt, cwd, sessionId, resume, approvalMode, model, skipTrust, policies, entry, onEvent })` :
   - lance `node <gemini.js>` avec `spawn`, sans shell, y compris sous Windows ;
   - passe `NO_BROWSER=true` et `GEMINI_CLI_NO_RELAUNCH=true` (sauf `relaunch: true`), et `--max-old-space-size` si `maxHeapMb` ;
   - repasse le dossier des politiques de l'utilisateur en tête dès qu'il ajoute un `--policy` ;
   - écrit le prompt sur l'entrée standard et la ferme (`child.stdin.end(prompt)`) ;
   - lit la sortie ligne à ligne (`readline`) : chaque ligne JSON est un événement ; une ligne illisible devient `{ type: 'raw', line }` ;
   - rend `{ pid, args, done, cancel }` ; `cancel()` envoie `SIGINT` puis `SIGKILL` après 5 s, ou `taskkill /T /F` sous Windows.
3. `rec.start(...)` journalise l'exécution (`engine_run`, argv sans le prompt) et l'événement sortant `prompt`, avant le premier événement reçu.
4. `onEvent` : `rec.event(...)` écrit l'événement tel quel, puis le serveur le relaie.
5. Fin du processus : `rec.end({ runId, code, stderr })`, puis `proj.projectPending()` projette le tour d'un bloc, dans une transaction.
6. Arrêt demandé par l'humain : `rec.cancel(...)` écrit `turn.cancel`, qui fait foi même sans code 130 (Windows).

## Événements du journal

| Source | Types | Écrit par |
|---|---|---|
| `headless` | `prompt` (sortant) ; `init`, `message`, `tool_use`, `tool_result`, `error`, `result` (entrants, tels que Gemini CLI les émet) ; `raw` | `rec.start`, `rec.event` |
| `board` | `artifact.snapshot`, `turn.cancel`, `project.upsert`, `conversation.delete` | `rec.snapshot`, `rec.cancel`, `rec.board` |
| prévus | `catalog.scan`, `component.edit`, `component.propose`, `component.ratify`, `component.check`, `component.adopt`, `component.deprecate`, `extension.materialize` (README, §9) ; sources `hook`, `import` (étape 6), `acp` (étape 8) | à venir |

Seules les colonnes de rattachement et de projection d'`event` sont modifiables (triggers de `migrations/001_init.sql`) : le projecteur y note `projected_at` et `projector_version`.

## Où ajouter quoi

| Changement | Fichiers | À ne pas oublier |
|---|---|---|
| Nouvelle option du lanceur | `packages/server/src/run-gemini.mjs` | comportement correspondant dans le faux Gemini CLI, test dans `packages/server/test/run-gemini.test.mjs`, README §6 |
| Nouvel événement, ou nouvelle règle de projection | `packages/server/src/projector.mjs` | `PROJECTOR_VERSION` + 1, test dans `packages/server/test/projector.test.mjs`, README §7.4 |
| Nouvelle action de gestion | `rec.board({ type, payload })`, puis sa règle de projection | type nommé `objet.verbe`, README §7.4 |
| Nouvelle table, colonne, vue | nouvelle migration `migrations/NNN_<objet>.sql` (commande `/board:migration`) | `packages/server/test/schema.test.mjs`, projecteur, README §7 ; une vue `v_*` modifiée est signalée dans le README |
| Nouveau scénario de spike | `spike/scenarios.mjs` | test dans `spike/test/capture.test.mjs`, `spike/README.md` |
| Nouveau composant (skill, commande, sous-agent) | `skills/<nom>/`, `commands/<ns>/<nom>.toml`, `agents/<nom>.md` | `node tools/check-components.mjs`, README §9.7 |
| Nouveau fichier de test | à côté des autres | l'inscrire dans `tools/run-tests.mjs` (liste `TEST_FILES`) |
| Serveur HTTP et WebSocket (étape 4) | `packages/server/src/server.mjs` (à venir), d'après l'esquisse du README, §6.3 | Fastify 5.12.7 et `@fastify/websocket` 11.3.4, `light-my-request` épinglé en 6.6.0 (`overrides`) |

## Composants et extension du dépôt

- `gemini-extension.json` : nom `geminiboard`, version (celle de la skill), `contextFileName` = `AGENTS.md`.
- `skills/geminiboard/` : cette skill. `commands/board/` : commandes `/board:*`. `agents/relecteur-board.md` : sous-agent relecteur, variante Gemini écrite à la main jusqu'à l'étape 8.
- Gemini CLI charge les skills de `skills/`, les commandes de `commands/`, les sous-agents de `agents/` et, s'ils existaient, `policies/` et `hooks/hooks.json` de l'extension : aucun de ces deux derniers n'existe ici. Un dossier `policies/` serait lu comme politique d'extension, dont Gemini CLI ignore les règles `allow` ; c'est pourquoi la politique du headless (`skills/geminiboard/assets/politique-headless.toml`) est rangée avec la skill.
- À l'étape 8 : source neutre des sous-agents, plugin Claude Code généré et contrôle de portabilité (README, §9.7).
