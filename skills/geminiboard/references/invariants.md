# Invariants

Dix règles qui tiennent à chaque étape. Les changer demande une décision ratifiée en PR (D6), jamais une PR ordinaire. Pour chacune : la règle, sa raison, sa mise en œuvre, son contrôle et les écarts typiques.

## 1. Écrivain unique

- **Règle.** Seul `board-server` écrit dans la base : le journal par `packages/server/src/recorder.mjs`, les projections par `packages/server/src/projector.mjs`. Le serveur MCP, Claude et les scripts lisent en lecture seule (`openJournal(path, { readonly: true })`, qui pose `query_only`).
- **Raison.** SQLite n'a qu'un écrivain à la fois ; un seul processus qui écrit garde l'ordre du journal et évite les verrous. Le client `geminiboard` et l'interface passent par l'API du serveur ; le relais de hooks (étape 6) lui postera ses événements au lieu d'écrire lui-même.
- **Écarts typiques.** Un `INSERT` ailleurs que dans ces deux modules ; un script de maintenance qui ouvre la base en écriture ; un deuxième serveur sur la même base.

## 2. Journal en ajout seul, projections reconstructibles

- **Règle.** Tout ce qui arrive (ligne JSONL, action du board, plus tard entrée de hook) s'écrit tel quel dans `event`, puis se projette. `event` ne se supprime pas et ne se réécrit pas : les triggers de `migrations/001_init.sql` le refusent, sauf pour les colonnes de rattachement et de projection. Vider les projections puis rejouer le journal redonne le même état (O2).
- **Raison.** Gemini CLI change de format chaque semaine : le brut conservé permet de reprojeter avec un projecteur corrigé ; le rejeu est aussi la reprise après un arrêt brutal.
- **Mise en œuvre.** Les projections ne dépendent que du journal : horodatages tirés des événements, clés dérivées (`stableId`, UUID version 8), jamais `Date.now()` ni hasard dans le projecteur. Toute règle de projection modifiée incrémente `PROJECTOR_VERSION`. Une suppression est un événement (`conversation.delete`), que le rejeu respecte.
- **Contrôle.** Test de reconstruction à l'identique dans `packages/server/test/projector.test.mjs` et rejeu des corpus (`packages/server/test/corpus.test.mjs`) ; `verifier.mjs` avertit si le projecteur change sans que sa version change.
- **Écarts typiques.** Un `UPDATE event` ; une projection qui lit l'horloge ; une règle de projection modifiée sans changement de version ; une donnée écrite directement dans une table de projection.

## 3. Migrations figées

- **Règle.** Une migration présente sur `main` ne se modifie plus, même pour une faute de frappe dans un commentaire : toute évolution passe par un nouveau fichier `migrations/NNN_<objet>.sql`, numéroté à la suite, sans trou. Seuls les noms `NNN_nom.sql` sont chargés.
- **Raison.** `journal.mjs` garde l'empreinte sha256 de chaque migration appliquée et refuse d'ouvrir une base dont une migration a changé ; une base déjà créée sur un poste serait bloquée. L'empreinte ignore les fins de ligne : un clone Windows (CRLF) et un clone WSL2 (LF) donnent la même.
- **Mise en œuvre.** Style de `migrations/001_init.sql` : tables `STRICT` ; JSON contrôlé par `json_valid()` ; horodatages ISO 8601 UTC à la milliseconde, en texte ; booléens 0 ou 1 ; UUIDv7 en texte pour les entités exposées (URL, API, MCP), entiers pour les tables à fort volume ; commentaires en français. Une vue `v_*` est un contrat de lecture : la modifier se signale dans le README. La commande `/board:migration` guide la création.
- **Contrôle.** Empreinte vérifiée à l'ouverture (test dans `packages/server/test/schema.test.mjs`) ; `verifier.mjs` compare chaque migration à celle de la base git et contrôle noms et numérotation ; `etat.mjs --migrations` donne le prochain numéro.
- **Écarts typiques.** Corriger `001_init.sql` « parce que ce n'est qu'un commentaire » ; deux branches qui créent chacune une `002` ; une migration sans test.

## 4. Prompt sur l'entrée standard

- **Règle.** Le texte saisi va à Gemini CLI par son entrée standard (`child.stdin.end(prompt)`), jamais en argument, jamais par un shell (`shell: true` est proscrit, y compris sous Windows). Gemini CLI est lancé comme `node <gemini.js>`, pas par le raccourci `gemini.cmd`.
- **Raison.** Un prompt contient des guillemets, `$()`, `;` ou `&` : par un shell, ce serait une injection de commande. En argument, il serait visible dans `ps` et dans `engine_run.argv_json`. En 0.65, un argument positionnel ouvre d'ailleurs le mode interactif.
- **Contrôle.** Tests du lanceur (`packages/server/test/run-gemini.test.mjs`) : prompt piégé transmis intact, argv sans le prompt.
- **Écarts typiques.** Un `-p` ou `--prompt` ajouté pour aller plus vite ; `exec()` ou `execSync()` avec une chaîne ; `spawn('gemini', …, { shell: true })` pour contourner un problème Windows.

## 5. Node.js 20

- **Règle.** Le code et toutes ses bibliothèques tournent sous Node.js 20 (D10), sur le poste comme en CI. better-sqlite3 reste en 12.9.0, dernière version livrée précompilée pour Node.js 20 ; `node:sqlite` n'existe pas en Node.js 20.
- **Raison.** C'est la version du poste de travail. Le passage à Node.js 22 est une question ouverte (Q12), pas une décision.
- **Mise en œuvre.** Avant d'ajouter une bibliothèque : lire son champ `engines` et celui de ses dépendances, puis l'installer et lancer les tests sous Node.js 20. Une dépendance transitive trop récente s'épingle par `overrides` (exemple : `light-my-request` 6.6.0, car la 6.8.0 tire `cookie` 2, qui exige Node.js 22).
- **Contrôle.** `verifier.mjs` évalue le champ `engines.node` de chaque paquet de `package-lock.json` pour Node.js 20.19 ; la CI teste Node.js 20 et 22 ; `tests.yml` vérifie que better-sqlite3 s'installe sans compilation.
- **Écarts typiques.** `npm install <paquet>@latest` sans vérification ; une API apparue après Node.js 20, comme `node:sqlite`, `fs.glob` ou `Promise.withResolvers`.

## 6. Windows natif et WSL2

- **Règle.** Tout tourne sous Windows natif comme sous Linux ou WSL2 (D13).
- **Mise en œuvre.**
  - Scripts en Node.js, jamais en bash ; commandes proposées une par ligne, sans `&&` (Windows PowerShell 5.1 ne le connaît pas).
  - Chemins reconnus à leur forme (`C:\…`, `\\serveur\…`), comparés sans tenir compte de la casse sous Windows ; un artefact garde un chemin relatif au projet, avec des `/`.
  - Arrêt : `taskkill /T /F` sous Windows, où Node.js ne sait pas envoyer `SIGINT` et où le code 130 n'existe pas ; `turn.cancel` fait foi.
  - Codes de sortie sur 32 bits sous Windows : une erreur d'API sort avec 400, contre 144 ailleurs.
  - Fins de ligne : `.gitattributes` impose LF ; tout code qui lit un fichier du dépôt tolère CRLF.
  - Suppression de dossiers : `rmSync` avec `maxRetries` (EBUSY sous Windows).
  - Pas de lien symbolique dans le produit : il demande des droits particuliers sous Windows. Un test peut créer une jonction (`symlinkSync(cible, lien, 'junction')`), qui n'en demande pas.
  - Dossier saisi ramené à sa forme canonique (`realpathSync.native`) : un nom court (`JEANDU~1`) ou un lien désignent le même dossier que sa forme longue.
- **Contrôle.** CI sous Ubuntu et sous Windows (`.github/workflows/tests.yml`, `.github/workflows/gemini-cli.yml`).
- **Écarts typiques.** `path.join` sur un chemin venu de l'autre système ; un test qui suppose `/tmp` ; un `\n` attendu en dur dans une sortie de Gemini CLI sous Windows ; un test sauté sous Windows sans dire pourquoi.

## 7. Aucun identifiant

- **Règle.** Le board ne détient, ne lit et ne journalise aucun identifiant : la connexion et les clés restent celles de Gemini CLI (`.gemini`, variables d'environnement). Les serveurs MCP reçoivent leurs secrets par des références `$VAR` ou `${VAR}`, résolues par Gemini CLI dans son environnement. Le serveur n'écoute que sur `127.0.0.1` et refuse un hôte ou une origine étrangers, WebSocket compris.
- **Mise en œuvre.** `NO_BROWSER=true`, pour qu'un Gemini CLI non connecté sorte avec le code 41 au lieu de lire le prompt comme une réponse ; secrets masqués avant écriture et dans le flux relayé (`packages/server/src/redact.mjs`, colonne `event.redacted`), Gemini CLI recevant le prompt intact ; politique de capture du projet (`full`, `metadata`, `off`) appliquée avant écriture (`packages/server/src/capture.mjs`).
- **Contrôle.** Tests du serveur (masquage, capture, hôte et origine) et `tools/check-server.mjs` sur le vrai Gemini CLI ; revue ; `verifier.mjs` cherche clés et jetons dans les lignes ajoutées.
- **Écarts typiques.** Lire `oauth_creds.json` « pour vérifier la connexion » ; une clé en clair dans un manifeste d'extension ou dans un test.

## 8. Ni dépôt d'un projet, ni fichiers internes de Gemini CLI

- **Règle.** Le board n'écrit jamais dans le dépôt d'un projet (pas de `.gemini/` ajouté, pas de `GEMINI.md` modifié) ni dans les fichiers internes de Gemini CLI (`extension-enablement.json`, `acknowledgments/agents.json`, réglages). Il passe par les commandes publiques (`gemini extensions link`, `enable`, `disable`) et par ses propres extensions de projet, sous `~/.geminiboard/extensions/` (D15, D16).
- **Raison.** Les dépôts des projets appartiennent à leurs équipes ; les formats internes de Gemini CLI changent sans préavis.
- **Contrôle.** Revue ; spike S5 (`spike/catalogue.mjs`) pour le mécanisme d'activation.
- **Écarts typiques.** Écrire dans `~/.gemini/settings.json` pour activer un composant ; reconnaître un agent en écrivant son empreinte.

## 9. Dépôt public

- **Règle.** Ce dépôt est public : ni donnée de client ou de travail, ni extrait de session réelle non masqué, ni nom, adresse ou chemin personnel réels, ni base SQLite. Les exemples sont fictifs : `jean.dupont`, `jean.dupont@example.com`, `JEANDU~1`, `<HOME>`, `<USER>`, `<WORKSPACE>`.
- **Mise en œuvre.** Fixtures synthétiques, ou produites par le spike, qui masque chemins, nom d'utilisateur, adresses et clés ; relecture humaine d'un corpus avant son commit. Les noms de clients ne figurent nulle part dans le dépôt, pas même dans un contrôle : ils vont dans le fichier local de motifs du vérificateur (`GEMINIBOARD_MOTIFS`, ou `~/.geminiboard/motifs-interdits.txt`).
- **Contrôle.** `verifier.mjs` : fichiers interdits (base, `.env`, identifiants), clés et jetons, motifs locaux (échecs), adresses et chemins personnels (avertissements).
- **Écarts typiques.** Coller une sortie réelle de Gemini CLI dans un test ; garder son vrai nom dans un exemple ; committer `fixtures/` sans relecture.

## 10. Composants portables

- **Règle.** Une skill, une commande ou un sous-agent écrit une fois sert Gemini CLI et Claude Code (D2, O4).
- **Mise en œuvre.**
  - Skill : `skills/<nom>/SKILL.md`, frontmatter limité à `name` (égal au dossier) et `description` ; détail dans `references/`, `scripts/`, `assets/`, tous cités par SKILL.md ; texte qui nomme les deux familles d'outils.
  - Commande : TOML (D1), clés `prompt` et `description` seulement ; `{{args}}` ; injections `!{…}` autorisées par une politique du dépôt pour le headless.
  - Sous-agent : frontmatter strict de Gemini CLI 0.65 (`kind`, `name`, `description`, `display_name`, `tools`, `mcp_servers`, `model`, `temperature`, `max_turns`, `timeout_mins`), outils connus.
  - Contexte : `AGENTS.md`, source unique.
- **Contrôle.** `node tools/check-components.mjs` (dans `verifier.mjs` et dans les tests) ; `tools/check-extension.mjs` contre le vrai Gemini CLI en CI.
- **Écarts typiques.** Un champ `version` ou `allowed-tools` dans le frontmatter d'une skill ; une description YAML avec « : » sans guillemets (YAML la refuse) ; une barre oblique inverse dans un TOML entre guillemets doubles (`C:\Users` est un échappement invalide : utiliser `'''…'''`) ; une clé inconnue dans un sous-agent, que Gemini CLI refuse.
