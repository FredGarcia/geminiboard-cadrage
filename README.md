# GeminiBoard : cadrage

> **Statut** : proposition v0.2, à ratifier par PR · **Date** : 25 octobre 2026
>
> **Portée de ce dépôt** : le cadrage, le code du board (D11) et les composants portables (D12).

GeminiBoard est une interface locale, au style de celle de Claude, qui pilote Gemini CLI et gère les discussions, les projets, les artefacts, les sous-agents, les skills, les commandes et les outils. Chaque échange et chaque action de gestion sont journalisés dans **un seul fichier SQLite**, conçu pour être relu par Claude le jour où le travail passera sur Claude. Les composants (skills, sous-agents, commandes, hooks) restent **portables entre Gemini CLI et Claude Code**.

---

## 1. Contexte

- Gemini CLI est l'outil de travail actuel ; le passage à Claude est prévu.
- Gemini CLI se prête mal à la conception de skills et d'agents complexes : ils sont conçus avec Claude, publiés sur GitHub, puis installés dans Gemini CLI.
- Il manque une vue d'ensemble : les sessions sont rangées par projet dans `~/.gemini/tmp/` (30 jours de rétention par défaut), les composants sont dispersés entre dossier utilisateur, espaces de travail et extensions, et les décisions (autorisations, ratifications) ne laissent aucune trace exploitable.
- Gemini CLI publie une version par semaine (v0.65.0 le 20 octobre 2026). Le board conserve donc les événements bruts et versionne ses analyseurs, pour encaisser les changements de format.

GeminiBoard comble ce manque et prépare la transition : son journal devient la mémoire commune quand le travail se fera directement avec Claude.

## 2. Décisions déjà prises

| # | Décision | Date |
|---|---|---|
| D1 | Commandes au format TOML de Gemini CLI | 2026-10-24 |
| D2 | Skills et agents portables entre Gemini CLI et Claude | 2026-10-24 |
| D3 | Node.js ; Angular si le front est complexe | 2026-10-24 |
| D4 | Le schéma SQLite d'abord | 2026-10-24 |
| D5 | Interface au style de celle de Claude | 2026-10-24 |
| D6 | Travail en PR sur GitHub, ratification avant fusion | 2026-10-24 |
| D7 | Projet distinct, qui s'ajoute aux autres | 2026-10-24 |
| D8 | Journal des échanges et gestion dans un fichier SQLite unique, exploitable par Claude | 2026-10-24 |
| D9 | Capture : le board lance Gemini CLI à chaque prompt et relaie sa sortie standard vers l'interface (Q1) | 2026-10-25 |
| D10 | Toutes les bibliothèques sont compatibles avec Node.js 20 (Q2) | 2026-10-25 |
| D11 | Le code du board vit dans ce dépôt (Q5) | 2026-10-25 |
| D12 | Les composants portables vivent aussi dans ce dépôt (Q6) | 2026-10-25 |

Le front visé (flux en continu, panneaux, catalogue) est complexe : ce cadrage retient donc Angular au titre de D3. D10 limite Angular aux versions 20 et 21 (Q3).

## 3. Objectifs et non-objectifs

| # | Objectif | Critère de vérification |
|---|---|---|
| O1 | Tout échange Gemini CLI est retrouvable | Une session lancée depuis le board **ou** depuis un terminal apparaît dans la base, avec ses messages, ses appels d'outils et ses décisions (terminal : étape 6) |
| O2 | L'état est reconstructible | Vider les tables de projection puis rejouer le journal `event` redonne le même état |
| O3 | Claude lit la base sans transformation | Claude répond à « qu'a-t-on décidé sur X ? » par le serveur MCP ou à partir du fichier joint |
| O4 | Un composant écrit une fois sert les deux moteurs | Un skill, une commande et un sous-agent s'installent dans Gemini CLI et dans Claude Code depuis ce dépôt |
| O5 | L'interface est accessible | Parcours clés au clavier et au lecteur d'écran ; cible RGAA 4.1 et WCAG 2.2, niveau AA |

Hors périmètre de la v1 : réimplémenter l'agent (le board pilote Gemini CLI, il ne le remplace pas), le multi-utilisateur, l'hébergement distant, la synchronisation dans le cloud, l'édition collaborative en temps réel.

## 4. Périmètre fonctionnel

| Module | Fonctions |
|---|---|
| Discussions | créer, reprendre, rechercher, renommer, épingler, archiver, bifurquer ; affichage en continu ; interruption ; choix du modèle et du mode d'approbation (`default`, `auto_edit`, `yolo`, `plan`), fixé avant l'envoi |
| Projets | dossier racine et son approbation par l'humain, dépôt, instructions injectées au début de chaque session (sans modifier les fichiers du dépôt), connaissances, composants activés, discussions, politique de capture |
| Artefacts | détection des fichiers écrits par les outils (`write_file`, `replace`), épinglage d'un bloc de code, versions, différences entre versions, export |
| Catalogue | skills, sous-agents, commandes, hooks, serveurs MCP et outils, extensions, fichiers de contexte, politiques : découverte sur disque, versions, statut (brouillon, proposé, ratifié, obsolète), lien vers la PR, activation par projet, usages, export vers Claude |
| Exécutions | lancer une commande ou un agent en lot, suivre le statut et le code de sortie |
| Journal | événements bruts filtrables (source, type, session), rejeu, export |
| Réglages | moteurs détectés et leurs versions, chemins, secret HMAC, motifs de masquage |

## 5. Architecture

### 5.1 Vue d'ensemble

Les liens en pointillés arrivent aux étapes 6 et 8 de la feuille de route.

```mermaid
flowchart LR
  subgraph poste["Poste local (WSL2, Node.js 20)"]
    UI["Interface Angular<br/>au style de Claude"]
    SRV["board-server<br/>Fastify + WebSocket<br/>écrivain unique"]
    DB[("geminiboard.db<br/>SQLite, WAL")]
    G1["gemini --output-format stream-json<br/>un processus par prompt"]
    MCP["geminiboard-mcp<br/>lecture seule"]
    CL["Claude Code ou Gemini CLI<br/>clients MCP"]
    G3["gemini dans un terminal<br/>session manuelle"]
    HOOK["relais de hooks<br/>étape 6"]
    FS["~/.gemini/tmp/.../chats<br/>étape 6"]
    C1["claude-agent-acp<br/>étape 8, Node.js 22"]
  end
  UI <-->|"HTTP + WebSocket"| SRV
  SRV -->|"stdin : prompt"| G1
  G1 -->|"stdout : JSONL"| SRV
  SRV --> DB
  MCP -->|"mode=ro"| DB
  CL --> MCP
  G3 -.->|"hooks"| HOOK
  HOOK -.->|"POST signé HMAC"| SRV
  FS -.->|"import"| SRV
  SRV -.->|"ACP"| C1
```

- **Écrivain unique.** Seul `board-server` écrit dans la base, sur le modèle de l'agent médiateur d'Agent2Dev. Le relais de hooks lui transmettra ses événements ; le serveur MCP lit en lecture seule.
- **Journal d'abord.** Tout ce qui arrive (ligne JSONL, entrée de hook, action dans l'interface) est écrit tel quel dans `event`, puis projeté dans les tables métier. Un arrêt brutal ne perd rien : le rejeu reconstitue les messages à partir de leurs fragments.
- **Adaptateurs de moteur.** Un adaptateur par moteur et par canal : `gemini-cli` en headless pour la v1, puis ACP et `claude-code` à l'étape 8. Le reste du board ignore le moteur, ce qui prépare le passage à Claude.
- **Local.** Tout tourne sur le poste (WSL2, Ubuntu 24.04) ; le navigateur Windows accède au board par `localhost`.

### 5.2 Composants et versions

| Paquet | Rôle | Technologie |
|---|---|---|
| `packages/server` (`board-server`) | API HTTP, WebSocket vers l'interface, lanceur de Gemini CLI, projecteur, écriture SQLite | Node.js 20 (ES modules), Fastify, `@fastify/websocket`, better-sqlite3 |
| `packages/ui` (`board-ui`) | interface | Angular, Angular CDK |
| `packages/hook` (`geminiboard-hook`) | relais des hooks de Gemini CLI (et de Claude Code) vers le serveur | script Node autonome, sans dépendance |
| `packages/mcp` (`geminiboard-mcp`) | lecture de la base par Claude ou Gemini | serveur MCP stdio, Node.js |
| `packages/cli` (`geminiboard`) | migrations, import, rejeu, export Markdown, génération des variantes Claude | Node.js |

Versions compatibles avec Node.js 20 (D10), vérifiées le 25 octobre 2026 :

| Bibliothèque | Version retenue | Contrainte Node.js |
|---|---|---|
| Gemini CLI (`@google/gemini-cli`) | 0.65.0 | 20 et plus ; exécuté ici sous Node.js 20.20.2 |
| better-sqlite3 | 12.11.1 | 20.x, 22.x, 23.x, 24.x ; la 13 exige Node.js 22 |
| Fastify / `@fastify/websocket` | 5.12.7 / 11.3.4 | testés ici sous Node.js 20.20.2 |
| Angular | 20.x ou 21.x | `^20.19.0` ; la 22 exige Node.js 22.22.3 ou plus |
| `node:sqlite` | écarté | absent de Node.js 20 |
| `@agentclientprotocol/claude-agent-acp` | étape 8 | exige Node.js 22 |

Contrats du serveur (esquisse, précisés à l'étape 4) :

- REST : `/api/projects`, `/api/conversations`, `/api/conversations/:id/timeline`, `/api/artifacts`, `/api/components`, `/api/events`, `/api/search`.
- WebSocket `/ws` : reçoit `prompt` et `cancel` ; émet `turn.start`, `event`, `turn.end`, `turn.error` (implémentation de référence au §6.3).
- Ingestion (étape 6) : `POST /ingest/hook`, signé par HMAC-SHA256 (en-tête `X-GeminiBoard-Signature`).

Stockage local :

```text
~/.geminiboard/
├── geminiboard.db      base SQLite (+ -wal, -shm)
├── blobs/              binaires adressés par sha256 (images, pièces jointes)
├── spool/              événements de hooks en attente si le serveur est arrêté
├── secret              clé HMAC (droits 600)
└── config.json
```

### 5.3 Interface au style de Claude

| Zone | Contenu | Équivalent Claude |
|---|---|---|
| Barre latérale | nouvelle discussion, recherche, discussions récentes et épinglées, projets, artefacts, catalogue, journal, réglages | barre latérale |
| Fil | Markdown rendu au fil de l'eau, cartes d'appels d'outils (statut, entrées, sortie, diff), outils refusés signalés, bouton Arrêter ; demandes d'autorisation en ligne avec ACP (étape 8) | fil de conversation |
| Saisie | palette `/` (commandes et skills du catalogue), `@` (fichiers, sous-agents), pièces jointes, choix du modèle et du mode d'approbation | zone de saisie |
| Panneau de droite | artefact ouvert (rendu, source, versions, diff, copie, téléchargement) ou fiche du projet | panneau d'artefacts |
| Page projet | instructions, connaissances, discussions, composants activés, dossier et son approbation, dépôt | Projets |
| Catalogue | listes par type ; fiche avec versions, statut, PR et usages ; activation ; export vers Claude | propre à GeminiBoard |
| Journal | événements bruts, filtres, rejeu | propre à GeminiBoard |

Accessibilité (O5) : navigation complète au clavier, gestion du focus entre panneaux et dialogues, annonce du flux par une région `aria-live="polite"` phrase par phrase (et non jeton par jeton), contrastes de niveau AA, thèmes clair et sombre, respect de `prefers-reduced-motion`, repères et titres de page.

## 6. Capturer la sortie de Gemini CLI

### 6.1 Principe retenu (D9)

Pour chaque prompt, le board lance un processus Gemini CLI en mode headless et relaie sa sortie standard vers l'interface. La sortie est demandée au format `stream-json` : une ligne JSON par événement, que le board journalise avant de la relayer. La discussion garde sa mémoire d'un prompt à l'autre : le board choisit l'identifiant de session (`--session-id <uuid>` au premier tour), puis reprend la même session (`--resume <uuid>`).

```mermaid
sequenceDiagram
  autonumber
  participant U as Interface
  participant S as board-server
  participant G as gemini (headless)
  participant D as SQLite
  U->>S: prompt (WebSocket)
  S->>G: lance gemini --session-id ou --resume, prompt sur stdin
  S->>D: engine_run, event out "prompt"
  S-->>U: turn.start
  G-->>S: init, message user (JSONL)
  S->>D: event in (brut)
  S-->>U: événements
  G-->>S: message assistant (delta), tool_use, tool_result
  S->>D: event in (brut)
  S-->>U: événements
  G-->>S: result (statistiques), puis fin du processus
  S->>D: engine_run clos (code de sortie, stderr)
  S-->>U: turn.end
```

Corrections apportées à l'exemple proposé, vérifiées sur Gemini CLI 0.65.0 :

| Exemple proposé | Correction | Raison |
|---|---|---|
| `npx @google/gemini` | binaire `gemini` du paquet `@google/gemini-cli`, installé une fois | `@google/gemini` n'existe pas sur npm ; `npx` ajoute un délai à chaque prompt |
| prompt en argument positionnel | prompt écrit sur stdin | en 0.65, un argument positionnel ouvre le mode interactif ; un stdin non interactif bascule en headless et accepte jusqu'à 8 Mo |
| `shell: true` | pas de shell (sauf `gemini.cmd` sous Windows, où le prompt ne passe de toute façon pas par la ligne de commande) | apostrophes, guillemets, `$()` ou `;` d'un prompt seraient interprétés par le shell : injection de commande |
| sortie texte | `--output-format stream-json` | événements typés à journaliser : `init`, `message`, `tool_use`, `tool_result`, `error`, `result` |
| morceaux bruts (`data`) | découpage par ligne (`readline`) | un morceau peut couper une ligne JSON en deux |
| une session par prompt | `--session-id <uuid>`, puis `--resume <uuid>` | sinon, chaque prompt repart sans la mémoire de la discussion |
| pas d'arrêt | `SIGINT`, puis `SIGKILL` après 5 s | bouton Arrêter |
| `import { Fastify } from 'fastify'` | `import Fastify from 'fastify'` | Fastify s'exporte par défaut |

### 6.2 Contraintes du mode headless (Gemini CLI 0.65.0)

- **Autorisations.** Personne ne peut confirmer un outil en cours de tour : le moteur de politiques transforme toute demande de confirmation en refus. Le mode d'approbation se choisit donc avant l'envoi : `default` (les outils à confirmer, comme l'écriture de fichiers ou le shell, sont refusés), `auto_edit` (modifications de fichiers acceptées), `yolo` (tout est accepté), `plan` (lecture seule). Des règles de politique (`policies/*.toml`) peuvent autoriser des commandes précises.
- **Dossier approuvé.** Dans un dossier non approuvé, le mode headless s'arrête avec le code 55. Le board ne passe `--skip-trust` que pour un projet dont l'humain a approuvé le dossier (`project.trusted`), et journalise cette décision.
- **Codes de sortie.** 0 (succès), 1 (erreur générale), 41 (authentification), 42 (entrée invalide), 52 (configuration), 53 (limite de tours), 55 (dossier non approuvé), 130 (annulation). Une erreur d'API sort avec le statut HTTP modulo 256 (400 donne 144) : seul l'événement `result` fait foi.
- **Événements.** Tous portent `type` et `timestamp` ; champs propres à chaque type, relevés dans le code source (`packages/core/src/output/types.ts`) :

| Type | Champs |
|---|---|
| `init` | `session_id`, `model` |
| `message` | `role` (`user`, `assistant`), `content`, `delta` |
| `tool_use` | `tool_name`, `tool_id`, `parameters` |
| `tool_result` | `tool_id`, `status` (`success`, `error`), `output`, `error` |
| `error` | `severity` (`warning`, `error`), `message` |
| `result` | `status` (`success`, `error`), `error`, `stats` (`total_tokens`, `input_tokens`, `output_tokens`, `cached`, `input`, `duration_ms`, `tool_calls`, `models`) |

### 6.3 Implémentation de référence (Node.js 20)

`run-gemini.mjs` lance un tour ; `server.mjs` l'expose en WebSocket et journalise chaque événement dans SQLite. Le prompt ne passe jamais par la ligne de commande : il n'apparaît ni dans `ps`, ni dans `engine_run.argv_json`.

Vérifications du 25 octobre 2026, sous Node.js 20.20.2 :

- 27 contrôles contre un faux Gemini CLI, répétés trois fois : ordre des événements, ligne JSON coupée en deux écritures, prompt piégé (`$(…)`, guillemets, apostrophes, retours à la ligne) transmis intact, `--session-id` puis `--resume`, codes 42, 55 et 130, binaire absent, paramètres refusés, WebSocket de bout en bout, journal SQLite.
- Contre Gemini CLI 0.65.0 réel : sans authentification, sortie 41 ; dans un dossier non approuvé, sortie 55 ; avec `--skip-trust` et une clé invalide, `init` (avec l'UUIDv7 fourni par le board), `message` (prompt intact), `result` en erreur, sortie 144.

<details>
<summary><strong><code>run-gemini.mjs</code> : cliquer pour déplier</strong></summary>

```js
// run-gemini.mjs : lance un tour de Gemini CLI en mode headless et relaie ses événements.
// Node.js 20 ou plus, sans dépendance.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const APPROVAL_MODES = ['default', 'auto_edit', 'yolo', 'plan'];

// Codes de sortie de Gemini CLI 0.65. Une erreur d'API sort avec le statut HTTP modulo 256
// (400 donne 144) : c'est l'événement `result` (status: 'error') qui fait foi.
export const EXIT_CODES = {
  0: 'succès', 1: 'erreur générale', 41: 'authentification', 42: 'entrée invalide',
  52: 'configuration', 53: 'limite de tours', 55: 'dossier non approuvé', 130: 'annulation',
};

/**
 * @param {object}   o
 * @param {string}   o.prompt        texte saisi, transmis par stdin (jamais par la ligne de commande)
 * @param {string}   o.cwd           dossier racine du projet
 * @param {string}   o.sessionId     identifiant de la discussion, choisi par le board (UUID)
 * @param {boolean}  o.resume        false au premier tour (--session-id), true ensuite (--resume)
 * @param {string}  [o.approvalMode] default | auto_edit | yolo | plan
 * @param {string}  [o.model]
 * @param {boolean} [o.skipTrust]    true si l'humain a approuvé le dossier du projet dans le board
 * @param {string}  [o.bin]          binaire gemini (paquet npm @google/gemini-cli)
 * @param {object}  [o.env]          variables ajoutées à l'environnement du processus
 * @param {(event: object) => void} o.onEvent  appelé pour chaque ligne JSONL
 */
export function runGemini({ prompt, cwd, sessionId, resume, approvalMode = 'default', model, skipTrust = false,
  bin = 'gemini', env, onEvent }) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`sessionId invalide : ${sessionId}`);
  if (!APPROVAL_MODES.includes(approvalMode)) throw new Error(`mode d'approbation inconnu : ${approvalMode}`);
  if (model && !/^[\w.-]+$/.test(model)) throw new Error(`modèle invalide : ${model}`);

  const args = ['--output-format', 'stream-json', '--approval-mode', approvalMode,
    resume ? '--resume' : '--session-id', sessionId];
  if (model) args.push('--model', model);
  if (skipTrust) args.push('--skip-trust'); // sinon, dossier non approuvé : sortie 55

  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // gemini.cmd sous Windows ; le prompt ne passe pas par le shell
    windowsHide: true,
  });

  child.stdin.on('error', () => {}); // processus déjà terminé : l'erreur remonte par 'close'
  child.stdin.end(prompt);            // stdin non interactif : Gemini CLI passe en headless

  let observedSessionId = null;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { event = { type: 'raw', line }; }
    if (event.type === 'init') observedSessionId = event.session_id;
    onEvent(event);
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16384); });

  let cancelled = false;
  const done = new Promise((resolve, reject) => {
    child.once('error', reject); // binaire introuvable, droits...
    child.once('close', (code, signal) => resolve({
      code, signal, cancelled,
      // Arrêt demandé : code 130, ou fin par signal si l'arrêt arrive très tôt
      meaning: cancelled ? EXIT_CODES[130] : (EXIT_CODES[code] ?? null),
      sessionId: observedSessionId, stderr,
    }));
  });

  let killTimer = null;
  done.finally(() => clearTimeout(killTimer)).catch(() => {});
  const cancel = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    cancelled = true;
    child.kill('SIGINT');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  };

  return { pid: child.pid, args, done, cancel };
}
```

</details>

<details>
<summary><strong><code>server.mjs</code> : cliquer pour déplier</strong></summary>

```js
// server.mjs : esquisse du board-server. Une route WebSocket pilote Gemini CLI,
// chaque événement est journalisé dans SQLite puis relayé à l'interface.
// Node.js 20 ou plus : fastify 5, @fastify/websocket 11, better-sqlite3 12.
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runGemini } from './run-gemini.mjs';

// UUIDv7 : tri chronologique des discussions, accepté par --session-id
export function uuidv7() {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function openJournal(dbPath, migrationFile) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (db.pragma('user_version', { simple: true }) === 0) {
    const sql = readFileSync(migrationFile, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (version, name, checksum) VALUES (1, ?, ?)')
        .run('001_init', createHash('sha256').update(sql).digest('hex'));
      db.pragma('user_version = 1');
    })();
  }
  return db;
}

// trusted : dossier approuvé par l'humain ; dans le board, lu dans project.trusted
export async function buildServer({ dbPath, migrationFile, bin = 'gemini', cwd = process.cwd(), trusted = false }) {
  const db = openJournal(dbPath, migrationFile);
  const insertEvent = db.prepare(`INSERT INTO event
    (source, direction, type, engine_id, engine_run_id, engine_session_id, payload_json)
    VALUES ('headless', ?, ?, 'gemini-cli', ?, ?, ?)`);
  const insertRun = db.prepare(`INSERT INTO engine_run (id, engine_id, channel, argv_json, cwd, pid)
    VALUES (?, 'gemini-cli', 'headless', ?, ?, ?)`);
  const endRun = db.prepare(`UPDATE engine_run SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    exit_code = ?, stderr_tail = ? WHERE id = ?`);
  const sessionStarted = db.prepare(`SELECT 1 FROM event
    WHERE engine_session_id = ? AND source = 'headless' AND type = 'init' LIMIT 1`);

  const app = Fastify({ logger: false });
  await app.register(websocket);
  app.addHook('onClose', async () => db.close());

  // Messages reçus  : { type: 'prompt', conversationId?, text, approvalMode?, model? } | { type: 'cancel' }
  // Messages émis   : turn.start, event, turn.end, turn.error
  app.get('/ws', { websocket: true }, (socket) => {
    let current = null;
    const send = (msg) => socket.send(JSON.stringify(msg));

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return send({ type: 'turn.error', message: 'JSON invalide' }); }
      if (msg.type === 'cancel') return current?.cancel();
      if (msg.type !== 'prompt' || typeof msg.text !== 'string') return;
      if (current) return send({ type: 'turn.error', message: 'un tour est déjà en cours' });

      const conversationId = msg.conversationId ?? uuidv7();
      const resume = Boolean(sessionStarted.get(conversationId));
      const runId = uuidv7();
      try {
        current = runGemini({
          prompt: msg.text, cwd, sessionId: conversationId, resume,
          approvalMode: msg.approvalMode ?? 'default', model: msg.model, skipTrust: trusted, bin,
          onEvent: (event) => {
            insertEvent.run('in', String(event.type), runId, conversationId, JSON.stringify(event));
            send({ type: 'event', conversationId, event });
          },
        });
      } catch (e) {
        return send({ type: 'turn.error', conversationId, message: e.message });
      }
      // Synchrone, donc écrit avant le premier événement reçu ; le prompt n'est pas dans argv
      insertRun.run(runId, JSON.stringify([bin, ...current.args]), cwd, current.pid ?? null);
      insertEvent.run('out', 'prompt', runId, conversationId,
        JSON.stringify({ text: msg.text, approvalMode: msg.approvalMode ?? 'default', resume }));
      send({ type: 'turn.start', conversationId, resume });

      try {
        const r = await current.done;
        endRun.run(r.code, r.stderr.slice(-4096), runId);
        send({ type: 'turn.end', conversationId, code: r.code, meaning: r.meaning });
      } catch (e) {
        endRun.run(null, e.message, runId);
        send({ type: 'turn.error', conversationId, message: e.message });
      } finally {
        current = null;
      }
    });

    socket.on('close', () => current?.cancel());
  });

  return app;
}

// Lancement direct : node server.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const home = process.env.HOME ?? '.';
  const app = await buildServer({
    dbPath: process.env.GEMINIBOARD_DB ?? `${home}/.geminiboard/geminiboard.db`,
    migrationFile: new URL('./migrations/001_init.sql', import.meta.url),
  });
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3210) });
}
```

</details>

### 6.4 Canaux complémentaires

| Canal | Étape | Usage |
|---|---|---|
| Hooks (`~/.gemini/settings.json` → `geminiboard-hook`) | 6 | sessions lancées à la main dans un terminal (O1) : `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, `SessionEnd` |
| Import de `~/.gemini/tmp/<project_hash>/chats/` | 6 | rattrapage de l'historique ; format non documenté |
| ACP (`gemini --acp`) | 8 | autorisations en cours de tour ; même protocole pour Claude Code avec `claude-agent-acp`, qui exige Node.js 22 |

Une session moteur ne donne qu'une discussion (`UNIQUE (engine_id, engine_session_id)`), projetée par un seul canal ; les autres restent consignés dans le journal brut.

Le relais de hooks obéira à trois règles :

1. Il n'écrit sur stdout que `{}` et sort avec le code 0 : il n'influe jamais sur les décisions de Gemini CLI.
2. Il poste l'entrée reçue au serveur avec une signature HMAC et un délai court ; si le serveur ne répond pas, il ajoute l'événement au `spool/`, que le serveur ingère au démarrage.
3. Par défaut, il ne s'abonne ni à `BeforeModel`, ni à `AfterModel`, ni à `BeforeToolSelection` : leur entrée contient la requête complète envoyée au modèle (volume important, données sensibles).

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "geminiboard",
            "type": "command",
            "command": "node \"$HOME/.geminiboard/bin/geminiboard-hook.mjs\"",
            "timeout": 2000
          }
        ]
      }
    ]
  }
}
```

La même entrée sera déclarée pour `SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent`, `SessionEnd`, `Notification` et `PreCompress`.

## 7. Schéma SQLite v0

### 7.1 Principes

- Un fichier unique, mode WAL, clés étrangères actives, tables `STRICT`.
- Le journal brut `event` est en ajout seul (garanti par des triggers) et constitue la seule source de vérité. Les autres tables sont des projections reconstructibles ; chaque événement traité porte la version du projecteur.
- Une session moteur correspond à une seule discussion, quel que soit le canal. En headless, l'identifiant de la discussion sert d'identifiant de session à Gemini CLI.
- Clés : UUIDv7 (texte) pour les entités exposées dans les URL, l'API et le MCP (projet, discussion, artefact, composant, exécution) ; entiers pour les tables à fort volume, dont le rowid stable sert de clé aux index plein texte.
- Recherche plein texte FTS5 insensible aux accents (`unicode61 remove_diacritics 2`) sur les messages, les artefacts et les connaissances.
- Binaires hors base (`blobs/`, adressés par sha256) ; textes en base.
- Le catalogue versionne chaque composant avec un statut de ratification, calqué sur le cycle proposer, ratifier, appliquer.
- Les décisions humaines (approbation d'un dossier, autorisations, ratifications, retours) sont des données de premier rang.

### 7.2 Diagramme

```mermaid
erDiagram
  project ||--o{ project_document : "connaissances"
  project |o--o{ conversation : "regroupe"
  project |o--o{ artifact : "contient"
  project ||--o{ project_component : "active"
  component ||--o{ project_component : "activé dans"
  component ||--o{ component_version : "versions"
  component |o--o{ component : "parent de"
  engine ||--o{ engine_run : "lance"
  engine ||--o{ conversation : "moteur de"
  conversation ||--o{ turn : "tours"
  conversation ||--o{ message : "messages"
  conversation ||--o{ tool_call : "appels d'outils"
  turn |o--o{ message : "produit"
  turn |o--o{ tool_call : "déclenche"
  engine_run |o--o{ turn : "exécute"
  tool_call ||--o{ permission_request : "demande"
  artifact ||--|{ artifact_version : "versions"
  tool_call |o--o{ artifact_version : "écrit"
  conversation ||--o{ component_usage : "utilise"
  component ||--o{ component_usage : "servi dans"
  component_version |o--o{ component_usage : "version servie"
  conversation |o--o{ event : "journal"
  engine_run |o--o{ event : "émet"
```

### 7.3 Tables

| Groupe | Table | Contenu |
|---|---|---|
| Méta | `schema_migration`, `setting` | migrations appliquées (avec leur sha256), réglages |
| Moteurs | `engine` | `gemini-cli`, `claude-code`, version détectée |
| | `engine_run` | processus lancé par le board : canal, argv (sans le prompt), pid, code de sortie, fin de stderr |
| Projets | `project` | dossier racine et son approbation (`trusted`), dépôt, instructions, `gemini_project_hash`, politique de capture |
| | `project_document` | connaissances du projet (texte indexé ou binaire) |
| Discussions | `conversation` | moteur, `engine_session_id`, canal, modèle, mode d'approbation, statut, discussion parente |
| | `turn` | un prompt et ses suites : statut, raison d'arrêt, jetons, durée, commande d'origine |
| | `message` | rôles `user`, `assistant`, `thought`, `system` ; séquence partagée avec `tool_call` |
| | `tool_call` | outil, nature (`read`, `edit`, `execute`…), entrées, sortie, fichiers touchés, statut, composant concerné |
| | `permission_request` | options proposées, décision, auteur de la décision (`human`, `policy`, `hook`, `auto`) ; alimentée à partir de l'étape 8 (ACP) |
| Artefacts | `artifact`, `artifact_version` | fichier ou bloc suivi ; versions avec leur origine (outil, message, humain) |
| Catalogue | `component` | skill, sous-agent, commande, hook, serveur MCP, outil, extension, fichier de contexte, politique ; portée, dépôt source, cibles (`gemini`, `claude`, `both`) |
| | `component_version` | contenu, empreinte, statut (`draft`, `proposed`, `ratified`, `deprecated`), commit, PR |
| | `project_component` | activation par projet, version épinglée |
| | `component_usage` | quelle version a servi dans quelle discussion (`activated`, `invoked`, `delegated`, `fired`, `blocked`) |
| Journal | `event` | entrée brute (`headless`, `hook`, `import`, `acp`, `pty`, `board`), sens, type, session, charge JSON, état de projection |
| Retours | `feedback` | note et commentaire sur un message, un appel, un tour ou une version |
| Lecture | `v_timeline`, `v_conversation_overview`, `v_component_current` | vues stables pour l'interface, le serveur MCP et Claude |

### 7.4 Règles de projection

| Entrée | Projection |
|---|---|
| Nouvelle discussion dans l'interface | `conversation` (`channel = headless`, `engine_session_id` = son identifiant) |
| Prompt envoyé (`event` sortant `prompt`) | `turn` (`running`) |
| `init` | modèle de la discussion et du tour |
| `message` `user` | `message` `user` |
| `message` `assistant` (`delta`) | tampon en mémoire, puis `message` `assistant` écrit à sa clôture (début d'un `tool_use` ou fin du tour) ; les fragments restent dans `event` |
| `tool_use`, puis `tool_result` | `tool_call` (clé : `tool_id`), statut `completed` ou `failed`, sortie |
| `error` | reste dans `event` ; `turn` en `error` si `severity = error` |
| `result` | `turn` clos : `success` donne `completed`, `error` donne `error` ; jetons et durée tirés de `stats` |
| Fin du processus | `engine_run` (code de sortie, fin de stderr) ; arrêt demandé : `turn` `cancelled` |
| Appel `write_file` ou `replace` réussi | `artifact` (clé : projet et chemin) et nouvelle `artifact_version`, lue sur disque |
| `activate_skill`, commande `/ns:nom`, délégation à un sous-agent | `component_usage`, avec la version courante du composant |
| Action dans l'interface (approuver un dossier, ratifier une version…) | `event` (`source = board`, `direction = internal`), puis la table concernée |
| Suppression d'une discussion | événement de suppression ; les projections partent en cascade, le journal reste, le rejeu respecte la suppression |
| Hooks, import, ACP (étapes 6 et 8) | mêmes tables, seulement si aucun autre canal ne projette déjà la session |

### 7.5 Validation

Le DDL ci-dessous passe les mêmes 35 contrôles dans trois environnements : Node.js 20.20.2 avec better-sqlite3 12.11.1 (SQLite 3.53.2), la cible retenue ; Node.js 22.23 avec better-sqlite3 13.0.3 et avec `node:sqlite` (SQLite 3.53.4). Les contrôles couvrent la migration, `integrity_check`, `foreign_key_check`, la recherche insensible aux accents, la mise à jour des index plein texte, le journal en ajout seul, les contraintes `CHECK`, `UNIQUE` et `STRICT`, les vues, la suppression en cascade et `VACUUM`. Le script de contrôle sera livré avec la migration à l'étape 2.

<details>
<summary><strong>Migration <code>001_init.sql</code> (v0) : cliquer pour déplier</strong></summary>

```sql
-- =====================================================================
-- GeminiBoard : schéma SQLite v0, migration 001_init (proposition à ratifier)
--
-- Fichier unique, mode WAL, un seul écrivain : le serveur du board.
-- Le serveur pose à chaque connexion : journal_mode=WAL, foreign_keys=ON,
-- busy_timeout=5000, synchronous=NORMAL. Le lanceur de migrations exécute
-- ce script dans une transaction, puis inscrit la version dans
-- schema_migration et dans PRAGMA user_version.
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
CREATE UNIQUE INDEX ux_tool_call_engine
  ON tool_call(conversation_id, engine_call_id) WHERE engine_call_id IS NOT NULL;
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
```

</details>

## 8. Lecture par Claude

Deux voies, au choix selon le contexte.

**Voie 1 : serveur MCP `geminiboard-mcp`** (stdio, lecture seule), déclaré dans Claude Code comme dans Gemini CLI. Gemini peut ainsi interroger son propre historique.

| Outil | Rôle |
|---|---|
| `search` | recherche plein texte dans les messages, les artefacts et les connaissances, filtrable par projet et par période |
| `list_conversations` | discussions récentes, par projet |
| `get_conversation` | une discussion en Markdown : messages, appels d'outils résumés, décisions |
| `get_artifact` | un artefact, à une version donnée |
| `list_components` | catalogue, avec version courante et statut |
| `query` | requête `SELECT` libre : connexion `mode=ro`, `PRAGMA query_only`, nombre de lignes plafonné |

**Voie 2 : fichier joint.** La base, ou un export filtré (`geminiboard export --project <slug>`), est jointe à une session Claude, qui l'interroge en SQL.

Un skill portable, `geminiboard-journal`, indique aux deux moteurs quand et comment interroger le journal. Le contrat de lecture repose sur les vues `v_*` : toute modification passe par une migration et une note de version.

## 9. Portabilité Gemini CLI ↔ Claude Code

État au 25 octobre 2026 (sources en fin de document) :

| Élément | Gemini CLI | Claude Code | Stratégie |
|---|---|---|---|
| Skill | `SKILL.md` (standard Agent Skills) dans `.gemini/skills/` ou son alias `.agents/skills/`, dans `~/.gemini/skills/` ou dans une extension ; activé par l'outil `activate_skill` ; `gemini skills install <url git>` | `SKILL.md` (même standard) dans `.claude/skills/`, `~/.claude/skills/` ou un plugin | **Source unique** ; frontmatter limité à `name` et `description` ; dossiers `scripts/`, `references/`, `assets/` |
| Commande | TOML dans `.gemini/commands/<ns>/<nom>.toml`, appelée par `/ns:nom` ; champs `prompt` et `description` ; `{{args}}`, `!{…}`, `@{…}` | Markdown dans `.claude/commands/`, ou skill ; `description`, `argument-hint` ; `$ARGUMENTS`, ``!`…` ``, `@fichier` | **Source TOML** (D1) ; variante Claude générée |
| Sous-agent | `.gemini/agents/<nom>.md`, frontmatter `name`, `description`, `tools`, `mcp_servers`, `model`, `temperature`, `max_turns`, `timeout_mins` ; réglage `experimental.enableAgents` | `.claude/agents/<nom>.md`, frontmatter `name`, `description`, `tools`, `model`… | source neutre ; deux variantes générées (correspondance des outils ci-dessous) |
| Hooks | `settings.json` ou `hooks/hooks.json` d'une extension ; stdin avec `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp` ; code 2 pour bloquer ; `timeout` en millisecondes | `settings.json` ou `hooks/hooks.json` d'un plugin ; stdin avec `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode` ; code 2 pour bloquer ; `timeout` en secondes | un seul script Node ; correspondance des événements ci-dessous ; délais convertis |
| Contexte | `GEMINI.md` ; `context.fileName` accepte `AGENTS.md` ; `contextFileName` dans une extension ; imports `@fichier.md` | `CLAUDE.md`, ou `AGENTS.md` lu nativement en l'absence de `CLAUDE.md` (v2.1.277 et suivantes) ; imports `@chemin` | **`AGENTS.md` comme source unique** |
| Distribution par GitHub | extension : `gemini-extension.json` à la racine ; `gemini extensions install <url> [--ref] [--auto-update]` | plugin : `.claude-plugin/plugin.json`, publié par une marketplace (`.claude-plugin/marketplace.json`) | ce dépôt sert les deux (arborescence ci-dessous) |

Conversion d'une commande TOML en commande Markdown pour Claude :

| TOML (Gemini CLI) | Markdown (Claude Code) |
|---|---|
| `description = "…"` | frontmatter `description: …` |
| `prompt = """…"""` | corps du fichier |
| `{{args}}` | `$ARGUMENTS` |
| `@{chemin}` | `@chemin` |
| `!{commande}` | ``!`commande` ``, avec un `allowed-tools` adapté |
| `commands/git/commit.toml`, appelée par `/git:commit` | `commands/git-commit.md`, appelée par `/<plugin>:git-commit` |

Correspondance des outils (sous-agents) :

| Gemini CLI | Claude Code |
|---|---|
| `read_file`, `read_many_files` | `Read` |
| `write_file` | `Write` |
| `replace` | `Edit` |
| `run_shell_command` | `Bash` |
| `glob` | `Glob` |
| `grep_search` | `Grep` |
| `web_fetch` | `WebFetch` |
| `google_web_search` | `WebSearch` |
| `activate_skill` | `Skill` |

Correspondance des événements de hooks :

| Gemini CLI | Claude Code |
|---|---|
| `SessionStart` | `SessionStart` |
| `BeforeAgent` | `UserPromptSubmit` |
| `BeforeTool` | `PreToolUse` |
| `AfterTool` | `PostToolUse` |
| `AfterAgent` | `Stop` |
| `PreCompress` | `PreCompact` |
| `Notification` | `Notification` |
| `SessionEnd` | `SessionEnd` |
| `BeforeModel`, `AfterModel`, `BeforeToolSelection` | pas d'équivalent direct |

Arborescence de ce dépôt (D11, D12) : à la fois extension Gemini CLI, marketplace Claude Code et code du board.

```text
geminiboard-cadrage/
├── README.md                        # ce cadrage
├── gemini-extension.json            # extension Gemini CLI, à la racine ; contextFileName = AGENTS.md
├── AGENTS.md                        # contexte, source unique
├── skills/<nom>/SKILL.md            # skills, source unique (dont geminiboard et geminiboard-journal)
├── commands/<ns>/<nom>.toml         # commandes, source TOML
├── agents/<nom>.md                  # sous-agents, variante Gemini (générée)
├── hooks/hooks.json                 # hooks, variante Gemini (relais geminiboard-hook, étape 6)
├── src/agents/<nom>.md              # sous-agents, source neutre
├── claude-plugin/                   # plugin Claude Code (généré)
│   ├── .claude-plugin/plugin.json
│   ├── skills/<nom>/SKILL.md        # copie des skills
│   ├── commands/<ns>-<nom>.md       # générées depuis commands/*.toml
│   ├── agents/<nom>.md              # variante Claude
│   └── hooks/hooks.json             # variante Claude
├── .claude-plugin/marketplace.json  # marketplace Claude ; source du plugin : ./claude-plugin
├── packages/                        # code du board : server, ui, hook, mcp, cli
├── migrations/001_init.sql
├── fixtures/                        # événements réels collectés au spike
└── tools/port.mjs                   # génération et contrôle de portabilité
```

Pourquoi un sous-dossier pour Claude : un plugin Claude charge toujours le `hooks/hooks.json` de sa racine (le manifeste ne fait que s'y ajouter) et ses chemins doivent rester sous sa racine. Placé à la racine du dépôt, il lirait les hooks au format Gemini ; d'où un plugin généré dans `claude-plugin/`, avec une copie des skills. `tools/port.mjs` contrôle aussi les invariants : frontmatter des skills, nom de skill égal au nom du dossier, TOML valide, outils connus des deux côtés.

Conséquence de D11 : `gemini extensions install https://github.com/FredGarcia/geminiboard-cadrage` copie tout le dépôt, code du board compris (sans `node_modules`, qui n'est pas versionné).

## 10. Lecture 7E

> « Les Éléments dans l'Espace Engendrent un État d'Expression Évolutif de l'Environnement »

| Terme | Dans GeminiBoard |
|---|---|
| Éléments | les entités du schéma : projets, discussions, tours, messages, appels d'outils, artefacts, composants |
| Espace | le fichier SQLite unique et l'espace de travail : dossiers racine, `~/.gemini`, dépôts GitHub |
| Engendrent | les événements bruts (stream-json, puis hooks, import et ACP, actions du board), écrits dans `event` |
| État | les projections, reconstructibles par rejeu |
| Expression | l'interface, les vues `v_*`, l'export Markdown, le serveur MCP |
| Évolutif | les versions des composants (du brouillon à la ratification), les migrations, la version du projecteur |
| Environnement | Gemini CLI, Claude Code, GitHub, le système de fichiers, et l'humain qui approuve, autorise et ratifie |

Second ordre : les décisions de l'observateur (approbations, autorisations, ratifications, retours) sont journalisées comme des données. Les agents les relisent par le serveur MCP et ajustent leur conduite ; le système s'observe en train d'être utilisé.

## 11. Sécurité et confidentialité

- Écoute sur `127.0.0.1` uniquement ; le board n'envoie aucune donnée hors du poste.
- Le prompt passe par stdin, jamais par une ligne de commande ni par un shell : pas d'injection, pas de prompt visible dans `ps`.
- `--skip-trust` seulement pour un dossier approuvé par l'humain dans le board (`project.trusted`), décision journalisée.
- Relais de hooks authentifié par HMAC-SHA256 (secret local, droits 600).
- Masquage avant écriture : motifs de secrets configurables (clés d'API, jetons, en-têtes `Authorization`) ; la colonne `event.redacted` trace leur application.
- Politique de capture par projet : `full`, `metadata` (sans contenu) ou `off`.
- La base n'est jamais versionnée. Ce dépôt public ne contient ni données ni extraits de session.
- Lecture par Claude : connexion `mode=ro` et `query_only` ; export filtré pour toute transmission hors du poste.
- Node.js 20 ne reçoit plus de correctifs de sécurité depuis le 30 avril 2026 (Q12).

## 12. Feuille de route

Chaque étape se termine par une ratification en PR.

| Étape | Livrable | Point de ratification |
|---|---|---|
| 0. Cadrage | ce README, décisions D1 à D12 | fusion de cette PR |
| 1. Spike de capture | `run-gemini.mjs` lancé sur le poste, avec un vrai compte : corpus d'événements dans `fixtures/` ; points S1 à S4 | corpus |
| 2. Schéma v1 | `migrations/001_init.sql` ajusté au corpus, projecteur rejoué sur les fixtures, script de contrôle | schéma v1 |
| 3. Skill de construction | skill `geminiboard` et commandes TOML qui guident Gemini CLI dans la construction du board, dans ce dépôt | skill 1.0.0 |
| 4. Serveur | `packages/server` : lanceur, journal, projecteur, API, WebSocket | une discussion de bout en bout |
| 5. Interface | Angular : barre latérale, fil en continu, mode d'approbation, panneau d'artefacts | parcours au clavier et au lecteur d'écran |
| 6. Catalogue et capture passive | découverte et versions des composants ; relais de hooks ; import des sessions | catalogue v1, O1 vérifié |
| 7. Lecture par Claude | `geminiboard-mcp`, skill `geminiboard-journal`, export | O3 vérifié |
| 8. Portabilité et ACP | `tools/port.mjs`, extension et plugin depuis ce dépôt ; ACP pour les autorisations en cours de tour et le moteur Claude (Node.js 22) | O4 vérifié |

Points à trancher par le spike, sur le poste et avec un vrai compte :

- **S1.** Corpus `stream-json` réel : tours avec outils, fragments `delta`, erreurs `error` et `result`.
- **S2.** Reprise `--resume <uuid>` sur plusieurs tours ; comportement si deux tours visent la même session.
- **S3.** Effet réel des modes d'approbation et des règles `policies/*.toml` en headless.
- **S4.** Délai de démarrage d'un processus par prompt sur le poste.

Points repoussés : format des fichiers de session et déclenchement des hooks (étape 6), ACP et `claude-agent-acp` (étape 8).

Tests : le projecteur est vérifié en rejouant les fixtures du spike ; l'interface, par des tests de bout en bout Playwright (le même outillage qu'Agent2Test).

## 13. Questions ouvertes

| # | Question | Proposition ou décision |
|---|---|---|
| Q1 | Canaux de capture | **Tranchée (D9)** : un processus par prompt, sortie relayée en `stream-json` ; hooks et import à l'étape 6, ACP à l'étape 8 |
| Q2 | Pilote SQLite | **Tranchée (D10)** : better-sqlite3 12.11.1, compatible avec Node.js 20 (la 13 exige Node.js 22 ; `node:sqlite` n'existe pas en Node.js 20) |
| Q3 | Version d'Angular | 20, comme le socle back-front d'Agent2Prompt, ou 21 ; la 22 est exclue par D10 |
| Q4 | Bibliothèque de composants | Angular CDK et composants maison, pour coller au style de Claude ; Angular Material en option |
| Q5 | Dépôt du code | **Tranchée (D11)** : ce dépôt |
| Q6 | Dépôt des composants portables | **Tranchée (D12)** : ce dépôt |
| Q7 | Rétention du journal brut | conservation intégrale ; un compactage des fragments après projection exigerait une exception au principe d'ajout seul |
| Q8 | Capture par défaut des projets professionnels | `metadata`, avec passage à `full` projet par projet |
| Q9 | Moteur `claude-code` dans le board | à l'étape 8, avec ACP ; exige Node.js 22 |
| Q10 | Fichier de contexte | `AGENTS.md` comme source unique, déclaré par `context.fileName` côté Gemini CLI |
| Q11 | Mode d'approbation par défaut d'une nouvelle discussion | `default` ; `auto_edit` ou `yolo` sur choix explicite, journalisé |
| Q12 | Passage à Node.js 22 | Node.js 20 n'a plus de correctifs depuis le 30 avril 2026 ; Node.js 22 ouvrirait Angular 22, better-sqlite3 13 et `claude-agent-acp` |
| Q13 | Nom du dépôt | le renommer `geminiboard` maintenant qu'il porte le code (GitHub redirige l'ancienne adresse) |

## 14. Références

Consultées le 25 octobre 2026.

**Gemini CLI**

- [Headless mode](https://www.geminicli.com/docs/cli/headless) · [ACP mode](https://geminicli.com/docs/cli/acp-mode/) · [CLI reference](https://geminicli.com/docs/cli/cli-reference) · [Trusted folders](https://geminicli.com/docs/cli/trusted-folders/)
- [Hooks](https://geminicli.com/docs/hooks/) · [Hooks reference](https://geminicli.com/docs/hooks/reference)
- [Agent Skills](https://geminicli.com/docs/cli/skills/) · [Creating Agent Skills](https://geminicli.com/docs/cli/creating-skills/)
- [Custom commands](https://www.geminicli.com/docs/cli/custom-commands) · [Session management](https://geminicli.com/docs/cli/session-management/)
- [Extension reference](https://geminicli.com/docs/extensions/reference/) · [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/) · [Tools reference](https://geminicli.com/docs/reference/tools)
- [Subagents have arrived in Gemini CLI](https://developers.googleblog.com/en/subagents-have-arrived-in-gemini-cli/)
- [Release v0.65.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.65.0) · code source : événements `stream-json` dans `packages/core/src/output/types.ts`, options `--acp` et `--experimental-acp` dans `packages/cli/src/config/config.ts`, champs des sous-agents dans `packages/core/src/agents/agentLoader.ts` ; aide (`gemini --help`), codes de sortie et politiques du paquet npm 0.65.0

**Agent Client Protocol**

- [Protocol overview](https://agentclientprotocol.com/protocol/overview)
- [SDK TypeScript `@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) · [adaptateur `@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)

**Claude Code**

- [Skills](https://code.claude.com/docs/en/skills) · [Subagents](https://code.claude.com/docs/en/sub-agents) · [Hooks](https://code.claude.com/docs/en/hooks)
- [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference) · [Memory, CLAUDE.md et AGENTS.md](https://code.claude.com/docs/en/memory)

**Node.js 20**

- Compatibilités relevées dans le registre npm (`engines` de better-sqlite3, @angular/core, @google/gemini-cli) · fin de support : [Node.js v20 goes EOL April 30](https://www.herodevs.com/blog-posts/node-js-v20-goes-eol-april-30----and-your-cloud-provider-is-pulling-the-plug-the-next-day)

**Standard** : [Agent Skills](https://agentskills.io)
