# Tests et CI

## Lancer

- `npm test`, à la racine (c'est `node tools/run-tests.mjs`), sous Node.js 20 : ni réseau, ni compte, ni secret.
- better-sqlite3 est un module natif : après un changement de version de Node.js, `npm rebuild better-sqlite3`. `etat.mjs` signale ce cas.
- Un seul fichier : `node --test packages/server/test/projector.test.mjs`. Un seul test : ajouter `--test-name-pattern "<début du nom>"`.
- `verifier.mjs` lance la suite complète et en donne le bilan ; `--sans-tests` la saute.
- Tout nouveau fichier de test s'inscrit dans `tools/run-tests.mjs` (liste `TEST_FILES`), sinon il ne tourne nulle part.

## Suites

| Fichier | Couvre |
|---|---|
| `packages/server/test/run-gemini.test.mjs` | lanceur contre le faux Gemini CLI : ordre des événements, ligne JSON coupée, prompt piégé intact, `--session-id` puis `--resume`, politiques, relance et tas, `NO_BROWSER`, codes de sortie, annulation, binaire absent, point d'entrée |
| `packages/server/test/schema.test.mjs` | migrations et empreintes (CRLF compris), lecture seule, contraintes, plein texte sans accents, journal en ajout seul, vues |
| `packages/server/test/projector.test.mjs` | règles de projection, artefacts et instantanés, composants, reprise après arrêt, suppression, reconstruction à l'identique (O2), chemins POSIX et Windows |
| `packages/server/test/corpus.test.mjs` | rejeu d'un corpus synthétique produit par le spike, du même en version Windows, puis de chaque `fixtures/spike-*` du dépôt |
| `spike/test/capture.test.mjs` | spike contre le faux Gemini CLI : scénarios, rapport, masquage, mémoire |
| `tools/test/check-components.test.mjs` | contrôle des composants : TOML, frontmatter, injections, politiques, renvois ; composants du dépôt conformes |
| `tools/test/skill-scripts.test.mjs` | scripts de la skill : compatibilité Node.js 20, données sensibles, lignes ajoutées d'un diff, motifs locaux, lecture du README, `etat.mjs` |

## Faux Gemini CLI

`packages/server/test/fake-gemini.mjs` imite `--output-format stream-json` de la 0.65. Il se lance comme `gemini.js`, avec `node`, sans shell. Comportements :

| Déclencheur | Effet |
|---|---|
| prompt contenant `LONG`, ou `FAKE_GEMINI_HANG=1` | attend l'arrêt (sortie 130 sur `SIGINT`) |
| `FAIL42`, `FAIL55` | sortie 42 ou 55 |
| « Crée le fichier X » | écrit X si le mode d'approbation le permet (`auto_edit`, `yolo`) |
| « commande shell » | outil shell accepté en `yolo` ou avec `--policy`, refusé sinon |
| `APIERR`, ou `FAKE_GEMINI_APIERR=1` | erreur d'API : `result` en erreur, sortie 400 sous Windows et 144 ailleurs |
| `FAKE_GEMINI_EXIT=41` | échec d'authentification avant tout événement |
| `FAKE_GEMINI_LOGIN=1` | connexion sans identifiants en cache : 41 avec `NO_BROWSER`, sinon question sur stdout et sortie 42 |

Un nouveau comportement du lanceur s'accompagne du comportement correspondant dans le faux Gemini CLI, documenté dans son en-tête.

## Aides

`packages/server/test/helpers.mjs` : `freshBoard()` (base en mémoire, migrée, avec enregistreur et projecteur) ; `T(n)` (horodatage déterministe, n secondes après une origine fixe) ; `recordTurn(rec, …)` (un tour complet : prompt, événements, instantanés, fin) ; `projections(db)` (contenu trié des projections, pour comparer deux états) ; `fixtureWorkspace(dir)`, `spikeTurns(dir)`, `loadSpikeRun(rec, dir)`, `realCorpora(root)` pour les corpus.

## Écrire un test

- `node:test` et `node:assert/strict`, sans bibliothèque de test.
- Horodatages et identifiants déterministes (`T(n)`, identifiants fixes) : jamais l'horloge dans une comparaison d'état.
- Dossiers temporaires : `mkdtempSync(join(tmpdir(), '<préfixe>-'))`, supprimés par `rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })` (EBUSY sous Windows).
- Données synthétiques seulement : noms fictifs (`jean.dupont`), chemins masqués (`<HOME>`, `/travail/projet`, `C:\fixtures\workspace`), jamais une sortie réelle copiée.
- Une fausse clé ou un faux jeton se construit par morceaux (`'AI' + 'za' + …`) : sinon `verifier.mjs` signalerait le fichier de test lui-même.

## Plateformes

- Un test se saute sous Windows seulement s'il ne peut pas y avoir de sens, et dit pourquoi : `test('…', { skip: process.platform === 'win32' && 'raison' }, …)`.
- Codes de sortie : 400 sous Windows, 144 ailleurs, pour une erreur d'API ; pas de 130 sous Windows, où l'arrêt passe par `taskkill`.
- Chemins : reconnus à leur forme, comparés sans la casse sous Windows ; dans un JSON, les barres inverses sont doublées.
- Mode `bin` du lanceur (raccourci `gemini`) : sous Windows, il passe par `cmd.exe`, d'où un comportement différent pour un binaire absent.

## CI (GitHub Actions)

| Workflow | Déclenchement | Contenu |
|---|---|---|
| `.github/workflows/tests.yml` | chaque push | `npm ci`, contrôle que better-sqlite3 s'installe sans compilation, `npm run test:ci` ; Ubuntu et Windows, Node.js 20 et 22 |
| `.github/workflows/gemini-cli.yml` | chaque lundi, et chaque push qui touche le lanceur, le spike, les composants ou leurs contrôles | dernier Gemini CLI réel, sans compte : spike S4 avec une clé invalide, `tools/ci-spike-check.mjs`, spike S5 (`spike/catalogue.mjs`), extension du dépôt (`tools/check-extension.mjs`) ; Ubuntu et Windows, Node.js 20 |

- Lire un échec : chaque test en échec devient une annotation (`tools/ci-annotations.mjs`), et chaque étape du workflow `gemini-cli` publie la fin de sa sortie quand elle échoue (`tools/ci-run.mjs`). Les annotations se lisent dans la PR, ou par l'API des check runs (`gh api repos/<dépôt>/commits/<sha>/check-runs`, puis `…/check-runs/<id>/annotations`).
- Une PR ne se présente qu'avec les deux workflows au vert, sous Ubuntu et sous Windows.

## Nombres de tests

Le README les donne au §7.5 (total, réussis, sautés, sous Linux et sous Windows) : les mettre à jour dès qu'un test s'ajoute, d'après le bilan d'une exécution complète, jamais de tête.
