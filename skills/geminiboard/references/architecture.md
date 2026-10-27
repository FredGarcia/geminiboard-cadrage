# Architecture du dépôt

État à l'étape 4 (octobre 2026). Le cadrage complet est au README, §5 à §9 ; cette fiche dit où se trouve quoi et où ajouter quoi.

## Vue d'ensemble

- **`board-server`** : seul écrivain de la base. API HTTP et WebSocket sur `127.0.0.1` (README, §5.2). À chaque prompt, il lance un processus Gemini CLI en headless (D9), journalise chaque événement (secrets masqués, selon la politique de capture du projet), le relaie au client, puis projette le tour clos.
- **Client `geminiboard`** : client en ligne de commande du serveur (`packages/cli`), le moyen de ratifier l'étape 4 avant l'interface.
- **Gemini CLI** : un processus par prompt, `--output-format stream-json`, prompt écrit sur l'entrée standard. Discussion du board et session de Gemini CLI sont deux identifiants distincts : une discussion reprend (`--resume <uuid>`) sa dernière session qui a abouti, sinon elle en ouvre une nouvelle (`--session-id <uuid>`, UUID aléatoire) ; détail dans `references/gemini-cli.md`.
- **Base SQLite** unique (`~/.geminiboard/geminiboard.db`), mode WAL. Le journal brut `event` est en ajout seul ; les autres tables sont des projections, reconstructibles par rejeu (O2).
- **Lecture par Claude** (étape 7) : serveur MCP en lecture seule, ou fichier joint ; les vues `v_*` forment le contrat de lecture.
- **Interface** Angular au style de Claude (étape 5), cliente de la même API que `geminiboard`.

## Carte du code

| Chemin | Contenu |
|---|---|
| `packages/server/src/server.mjs` | serveur Fastify : `buildServer` (routes REST, WebSocket `/ws`, contrôle de l'hôte et de l'origine, erreurs `{ error: { code, message } }`), `startServer`, `loadConfig` (`config.json`), `boardHome`, `slugify`, `DEFAULT_PORT` ; `npm start` le lance |
| `packages/server/src/turns.mjs` | `createTurnManager` : conduite des tours (refus, choix de la session, lancement, journal, instantanés, projection, `turn.end`) ; `TurnError`, `readSnapshot`, `MAX_PROMPT_BYTES`, `MAX_SNAPSHOT_BYTES` |
| `packages/server/src/queries.mjs` | `createQueries` : toutes les lectures de l'API (projets, discussions, fil, artefacts, composants, journal, recherche, `resumableSession`) ; `ftsQuery` |
| `packages/server/src/redact.mjs` | `createRedactor` : masquage des secrets, à toute profondeur d'une valeur JSON |
| `packages/server/src/capture.mjs` | `CAPTURE_POLICIES`, `metadataOnly` (forme sans contenu d'un événement), `promptPayload` |
| `packages/server/src/run-gemini.mjs` | lanceur d'un tour : `runGemini`, `resolveGeminiEntry`, `userPoliciesDir`, `APPROVAL_MODES`, `EXIT_CODES` |
| `packages/server/src/journal.mjs` | `openJournal` (pragmas du board, ou lecture seule avec `query_only`), `migrate` (empreintes sha256, fins de ligne ignorées) |
| `packages/server/src/recorder.mjs` | `createRecorder` : unique point d'écriture du journal (`engine_run`, `event`) |
| `packages/server/src/projector.mjs` | `createProjector`, `PROJECTOR_VERSION` (3), et les aides `inside`, `stableId`, `toolKind` |
| `packages/server/src/uuidv7.mjs` | identifiants UUIDv7 des entités du board (pas des sessions de Gemini CLI) |
| `packages/server/test/` | tests du serveur ; faux Gemini CLI `packages/server/test/fake-gemini.mjs` ; aides `packages/server/test/helpers.mjs` |
| `packages/cli/src/geminiboard.mjs` | client `geminiboard` : `main`, `createClient`, `USAGE`, `CliError`, `shortError` ; serveur joint par `GEMINIBOARD_URL` (défaut `http://127.0.0.1:3210`) |
| `packages/cli/test/` | tests du client, contre un vrai serveur et le faux Gemini CLI |
| `migrations/001_init.sql` | schéma v1 : tables `STRICT`, triggers du journal, index plein texte, vues `v_*` |
| `spike/` | spike de capture S1 à S4 (`spike/capture.mjs`, avec `spike/scenarios.mjs`, `spike/redact.mjs`, `spike/memory.mjs`) et S5 (`spike/catalogue.mjs`) |
| `fixtures/` | corpus produits par le spike, rejoués par les tests ; `fixtures/README.md` en donne le format |
| `tools/` | `tools/run-tests.mjs` ; contrôles des composants `tools/check-components.mjs` et `tools/check-extension.mjs` ; contrôle du serveur sur le vrai Gemini CLI `tools/check-server.mjs` ; outils de la CI `tools/ci-run.mjs`, `tools/ci-annotations.mjs`, `tools/ci-spike-check.mjs` |
| `skills/`, `commands/`, `agents/` | composants portables (D12) ; avec `gemini-extension.json` et `AGENTS.md` à la racine, le dépôt est une extension Gemini CLI |
| `.github/workflows/` | CI : `.github/workflows/tests.yml` (tests) et `.github/workflows/gemini-cli.yml` (vrai Gemini CLI) |

Paquets prévus au README, §5.2 (à venir) : `packages/ui` à l'étape 5, `packages/hook` à l'étape 6, `packages/mcp` à l'étape 7. L'inventaire du catalogue (README, §9.2) entre dans `packages/server` dans la PR qui suit le serveur.

## Un tour, de bout en bout

Message WebSocket `{ type: 'prompt', projectId ou conversationId, text, approvalMode?, model? }`, puis `turns.start(...)` :

1. Refus sans rien lancer, par une `TurnError` à code stable (`invalid`, `no_gemini`, `unknown_conversation`, `unknown_project`, `untrusted`, `missing_dir`, `limit`, `busy`) : le serveur répond `turn.error`. Deux codes viennent après le lancement : `spawn` (Gemini CLI n'a pas démarré) et `journal` (journal indisponible : le processus est aussitôt arrêté).
2. Session : `queries.resumableSession(conversationId)` donne la session du dernier `result` en succès de la discussion ; à défaut, `randomUUID()`, et `resume` vaut faux.
3. `runGemini({ prompt, cwd, sessionId, resume, approvalMode, model, skipTrust: true, entry, maxHeapMb, onEvent })` :
   - lance `node <gemini.js>` avec `spawn`, sans shell, y compris sous Windows ;
   - passe `NO_BROWSER=true` et `GEMINI_CLI_NO_RELAUNCH=true` (sauf `relaunch: true`), et `--max-old-space-size` si `maxHeapMb` ;
   - repasse le dossier des politiques de l'utilisateur en tête dès qu'il ajoute un `--policy` ;
   - écrit le prompt d'origine (non masqué) sur l'entrée standard et la ferme (`child.stdin.end(prompt)`) ;
   - lit la sortie ligne à ligne (`readline`) : chaque ligne JSON est un événement ; une ligne illisible devient `{ type: 'raw', line }` ;
   - rend `{ pid, args, done, cancel }` ; `cancel()` envoie `SIGINT` puis `SIGKILL` après 5 s, ou `taskkill /T /F` sous Windows.
4. `rec.start(...)` journalise l'exécution (`engine_run`, argv sans le prompt) et l'événement sortant `prompt` (masqué, avec `conversation_id`, selon la capture), avant le premier événement reçu. Capture `off` : rien n'est journalisé ; la session à reprendre est gardée en mémoire, le temps du serveur.
5. `onEvent` : masquage, puis `rec.event(...)` (événement complet, ou `metadataOnly` en capture `metadata`), instantané d'un fichier écrit par `write_file` ou `replace` (`rec.snapshot`, capture `full` seulement), relais au client.
6. Fin du processus : `rec.end({ runId, code, stderr })`, puis `proj.projectPending()` projette le tour d'un bloc, dans une transaction, et le serveur émet `turn.end` avec le statut projeté.
7. Arrêt demandé (`cancel`), client parti ou serveur arrêté : `rec.cancel(...)` écrit `turn.cancel`, qui fait foi même sans code 130 (Windows).

## Événements du journal

| Source | Types | Écrit par |
|---|---|---|
| `headless` | `prompt` (sortant) ; `init`, `message`, `tool_use`, `tool_result`, `error`, `result` (entrants, tels que Gemini CLI les émet, ou leur forme sans contenu en capture `metadata`) ; `raw` | `rec.start`, `rec.event` |
| `board` | `artifact.snapshot`, `turn.cancel`, `project.upsert` (état complet du projet), `conversation.delete` (`conversation_id`) | `rec.snapshot`, `rec.cancel`, `rec.board` |
| prévus | `catalog.scan`, `component.edit`, `component.propose`, `component.ratify`, `component.check`, `component.adopt`, `component.deprecate`, `extension.materialize` (README, §9) ; sources `hook`, `import` (étape 6), `acp` (étape 8) | à venir |

Seules les colonnes de rattachement et de projection d'`event` sont modifiables (triggers de `migrations/001_init.sql`) : le projecteur y note `conversation_id`, `projected_at` et `projector_version`.

## Où ajouter quoi

| Changement | Fichiers | À ne pas oublier |
|---|---|---|
| Nouvelle route de l'API | `packages/server/src/server.mjs` (schéma JSON, sans champ inconnu admis), lecture dans `packages/server/src/queries.mjs` | erreurs `{ error: { code, message } }` en français, test dans `packages/server/test/server.test.mjs`, README §5.2 |
| Nouveau message WebSocket, nouvelle règle de tour | `packages/server/src/server.mjs`, `packages/server/src/turns.mjs` | code de refus stable, test de bout en bout, README §5.2 et §6.3 |
| Nouvelle commande du client | `packages/cli/src/geminiboard.mjs` (et son `USAGE`) | test dans `packages/cli/test/cli.test.mjs`, README §6.3 ; une commande par ligne dans les exemples |
| Nouveau motif de secret intégré | `packages/server/src/redact.mjs` | test de masquage, README §11 ; une fausse clé de test se construit par morceaux |
| Nouvelle option du lanceur | `packages/server/src/run-gemini.mjs` | comportement correspondant dans le faux Gemini CLI, test dans `packages/server/test/run-gemini.test.mjs`, README §6 |
| Nouvel événement, ou nouvelle règle de projection | `packages/server/src/projector.mjs` | `PROJECTOR_VERSION` + 1, test dans `packages/server/test/projector.test.mjs`, README §7.4 |
| Nouvelle action de gestion | `rec.board({ type, payload })`, puis sa règle de projection | type nommé `objet.verbe`, README §7.4 |
| Nouvelle table, colonne, vue | nouvelle migration `migrations/NNN_<objet>.sql` (commande `/board:migration`) | `packages/server/test/schema.test.mjs`, projecteur, README §7 ; une vue `v_*` modifiée est signalée dans le README |
| Nouveau scénario de spike | `spike/scenarios.mjs` | test dans `spike/test/capture.test.mjs`, `spike/README.md` |
| Nouveau composant (skill, commande, sous-agent) | `skills/<nom>/`, `commands/<ns>/<nom>.toml`, `agents/<nom>.md` | `node tools/check-components.mjs`, README §9.7 |
| Nouveau fichier de test | à côté des autres | l'inscrire dans `tools/run-tests.mjs` (liste `TEST_FILES`) |
| Nouvelle bibliothèque | `package.json` du paquet | invariant 5 (Node.js 20) ; Fastify 5.12.7 et `@fastify/websocket` 11.3.4 tiennent avec `light-my-request` épinglé en 6.6.0 (`overrides`) |

## Composants et extension du dépôt

- `gemini-extension.json` : nom `geminiboard`, version (celle de la skill), `contextFileName` = `AGENTS.md`.
- `skills/geminiboard/` : cette skill. `commands/board/` : commandes `/board:*`. `agents/relecteur-board.md` : sous-agent relecteur, variante Gemini écrite à la main jusqu'à l'étape 8.
- Gemini CLI charge les skills de `skills/`, les commandes de `commands/`, les sous-agents de `agents/` et, s'ils existaient, `policies/` et `hooks/hooks.json` de l'extension : aucun de ces deux derniers n'existe ici. Un dossier `policies/` serait lu comme politique d'extension, dont Gemini CLI ignore les règles `allow` ; c'est pourquoi la politique du headless (`skills/geminiboard/assets/politique-headless.toml`) est rangée avec la skill.
- À l'étape 8 : source neutre des sous-agents, plugin Claude Code généré et contrôle de portabilité (README, §9.7).
