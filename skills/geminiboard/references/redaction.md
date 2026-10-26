# Rédaction : français du dépôt, décisions, commits et PR

## Langue et style

- Tout s'écrit en français : README, commentaires, messages des scripts, commits, PR. Les identifiants du code restent en anglais, comme l'existant.
- Phrases courtes et concrètes, un fait par phrase. Ce qui est vérifié se dit avec sa date et sa version (« vérifié le 26 octobre 2026 sur Gemini CLI 0.65.0 ») ; ce qui ne l'est pas se dit aussi (« à vérifier sur le poste »).
- Pas de formules creuses (« robuste », « puissant », « de manière efficace ») : dire ce que fait la chose.
- Typographie : espace avant « : », « ; », « ? » et « ! » ; guillemets « » ; apostrophe droite, comme dans le reste du dépôt ; points de suspension « … ».
- Nombres : virgule décimale (2,5 s) ; unités Mo, s, ms. Dates : « 26 octobre 2026 » dans le texte, `2026-10-26` dans le tableau des décisions.
- Graphies : Gemini CLI, Claude Code, Node.js, SQLite, GitHub, WSL2, PowerShell.
- Vocabulaire du dépôt : board, tour, discussion, journal, projection, composant, extension de projet, dossier approuvé, ratifier, headless.
- Exemples fictifs seulement (`jean.dupont`, `example.com`) ; aucun nom de client, aucune donnée de travail.

## Décisions et questions

- **Question** : ligne `| Qn | sujet | proposition (proposé) |` au §13, avec le numéro qui suit le plus grand existant. Une proposition que l'humain doit trancher en ratifiant la PR se termine par « (proposé) ».
- **Décision** : ligne `| Dn | énoncé (Qm) | date |` au §2, avec le numéro suivant. Elle ne naît que de la fusion d'une PR qui portait la proposition (D6), ou d'une réponse explicite de l'humain.
- **Après la fusion** d'une PR qui portait des propositions, au début du travail suivant :
  1. ajouter une décision par proposition au §2, datée du jour de la fusion ;
  2. marquer la question « **Tranchée (Dn)** : … » au §13 ;
  3. remplacer, dans le texte du README, les renvois à la question (Qm) par la décision (Dn).
- Une contradiction entre une demande et une décision se signale ; elle se règle par une nouvelle question, jamais par une décision changée en silence.

## Ligne de statut et feuille de route

- La ligne « **Statut** » en tête du README résume l'avancement de chaque étape, avec ses PR et ce qui reste.
- La ligne de l'étape au §12 donne le livrable, les PR et ce qui reste (« reste … »).
- Les nombres de tests du §7.5 suivent chaque ajout de test.

## Branches et commits

- Branches : `etape-<n>-<objet>` pour une étape, `cadrage-<objet>` pour le cadrage seul, `fix-<objet>` pour un correctif isolé.
- Message : `<type>: <résumé>`, ou `<type>(<portée>): <résumé>`, sans point final, en minuscule après les deux-points sauf nom propre. Types en usage : `feat` (fonction), `fix` (correctif), `docs` (README et documentation), `test`, `ci`, `spike`. Exemples tirés de l'historique :
  - `feat: étape 2, migration, journal et projecteur`
  - `fix: code de sortie d'une erreur d'API sous Windows (400, et non 144)`
  - `fix(spike): dossier de travail verrouillé sous Windows, sans arrêt du spike`
  - `docs: D13 (Windows natif ou WSL2), installation et connexion de Gemini CLI`
- Corps : le pourquoi, en quelques lignes, et les constats vérifiés. Un commit traite un sujet.
- Lignes d'attribution : celles que l'environnement de l'agent impose, s'il en impose.
- Avant de committer, une commande par ligne : `git status` (aucun fichier inattendu, aucune base, aucun `.env`), puis `git diff --cached --check`.

## Description de PR

Modèle :

```markdown
## Objet

Ce que la PR apporte, en une ou deux phrases, et la demande à laquelle elle répond.

## Changements

- Fichier ou groupe de fichiers : ce qui change, et pourquoi.

## À ratifier (README, §13)

| # | Question | Proposition |
|---|---|---|
| Qn | sujet | proposition |

## Vérifications du 26 octobre 2026

- **npm test :** N tests ; N passent, N sont sautés (raison). Sous Windows : … CI sous Ubuntu et Windows, Node.js 20 et 22.
- **Vrai Gemini CLI :** ce qui a été vérifié, avec la version, sans compte ou avec.
```

- Les nombres viennent d'une exécution réelle, jamais de tête.
- Sans proposition à ratifier, le dire : « Rien à ratifier en dehors du livrable ».
- Ni chemin local, ni nom réel, ni extrait de session dans la description : elle est publique.
