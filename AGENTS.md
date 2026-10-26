# GeminiBoard : contexte du dépôt

Ce contexte ne vaut que dans le dépôt `geminiboard-cadrage`. S'il apparaît dans une session ouverte ailleurs, l'extension `geminiboard` n'a pas été restreinte à ce dépôt : ignore-le et signale-le (installation au README, §9.7).

GeminiBoard est une interface locale, au style de celle de Claude, qui pilote Gemini CLI et journalise chaque échange dans un fichier SQLite unique. Ce dépôt contient le cadrage (`README.md`, qui fait foi), le code du board (`packages/`, `migrations/`, `spike/`, `tools/`) et les composants portables entre Gemini CLI et Claude Code (`skills/`, `commands/`, `agents/`).

## Avant toute modification

Active la skill `geminiboard` : sous Gemini CLI, par l'outil `activate_skill` ; sous Claude Code, en lisant `skills/geminiboard/SKILL.md`. Elle donne la méthode (situer, proposer, appliquer, vérifier, livrer), les invariants et les scripts du dépôt.

## Règles qui valent toujours

- Français pour la documentation, les commentaires, les messages, les commits et les PR ; identifiants du code en anglais, comme l'existant.
- Rien ne se fusionne sans ratification humaine en PR (D6) : ne pousse et n'ouvre de PR qu'à la demande.
- Une migration présente sur `main` ne se modifie jamais : toute évolution passe par un nouveau fichier `migrations/NNN_<objet>.sql`.
- Le prompt passe par l'entrée standard de Gemini CLI, jamais par sa ligne de commande ni par un shell.
- Node.js 20 : toute bibliothèque doit l'accepter (D10).
- Windows natif et WSL2 (D13) : scripts en Node.js plutôt qu'en bash ; une commande par ligne, sans `&&`.
- Dépôt public : ni donnée de client ou de session, ni nom, adresse ou chemin personnel réels, ni base SQLite.

## Commandes utiles, depuis la racine du dépôt

- `npm test` : suite de tests, sous Node.js 20.
- `node skills/geminiboard/scripts/etat.mjs` : état du dépôt et de la feuille de route.
- `node skills/geminiboard/scripts/verifier.mjs` : contrôles avant une PR.
- Sous Gemini CLI : `/board:etape`, `/board:verifier`, `/board:revue`, `/board:pr`, `/board:migration`.
