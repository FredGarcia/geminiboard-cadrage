---
name: geminiboard
description: Méthode, invariants et outils pour construire GeminiBoard dans le dépôt geminiboard-cadrage, qu'il s'agisse du lanceur de Gemini CLI, du journal SQLite, du projecteur, du serveur, de l'interface, du catalogue de composants, du spike ou du cadrage. À activer avant toute modification de ce dépôt, pour préparer une étape de la feuille de route, une migration, un test, une revue ou une PR.
---

# GeminiBoard : construire le board dans ce dépôt

GeminiBoard est une interface locale, au style de celle de Claude, qui pilote Gemini CLI et journalise chaque échange et chaque action de gestion dans un fichier SQLite unique, que Claude pourra relire. Le `README.md` est le cadrage et fait foi : décisions (§2), architecture (§5), capture (§6), schéma (§7), composants (§9), feuille de route (§12), questions (§13). Cette skill dit comment travailler dans le dépôt sans s'en écarter.

Les commandes se lancent depuis la racine du dépôt, une par une, sous bash comme sous PowerShell. Les chemins `references/…`, `scripts/…` et `assets/…` sont relatifs au dossier de la skill, `skills/geminiboard/` dans le dépôt ; les autres, à la racine du dépôt.

## Démarrer

1. `node skills/geminiboard/scripts/etat.mjs` : branche et écart avec `origin/main`, fichiers modifiés, étape, décisions, propositions en attente, migrations, Node.js, better-sqlite3 et Gemini CLI.
2. Sur `main`, crée une branche avant toute modification : `git switch -c etape-<n>-<objet>`.
3. Lis la fiche de l'étape dans `references/etapes.md`, puis les sections du README qu'elle cite.

## Méthode : situer, proposer, appliquer, vérifier, livrer

Le dépôt avance par points de contrôle : l'agent propose, l'humain ratifie, l'agent applique. La fusion d'une PR ratifie tout ce qu'elle contient, propositions comprises (D6).

### 1. Situer

- Repère l'étape, les décisions qui s'appliquent et les questions encore ouvertes.
- Lis le code que tu vas toucher et ses tests avant d'écrire ; `references/architecture.md` dit où se trouve quoi.
- Si des propositions attendent leur ratification alors que leur PR est fusionnée, consigne-les d'abord en décisions (`references/redaction.md`).
- Une demande qui contredit une décision ne s'exécute pas en silence : signale la contradiction et propose une question.

### 2. Proposer

Avant d'écrire, présente un plan court : livrables, fichiers, tests, invariants concernés, sections du README, questions à soumettre.

- Un choix que les décisions ne couvrent pas devient une question numérotée à la suite au §13, terminée par « (proposé) ».
- Attends l'accord explicite de l'humain avant un changement de décision, une nouvelle dépendance, une migration, la suppression d'un fichier, toute action sur GitHub (push, PR) et tout lancement du spike avec un vrai compte, qui consomme du quota.
- Un correctif local, dans le périmètre de l'étape et sans ces conséquences, se fait directement : dis-le.

### 3. Appliquer

- Petits commits cohérents, messages au format du dépôt (`references/redaction.md`).
- Chaque changement de comportement arrive avec son test (`references/tests.md`).
- Le README suit dans la même PR : ligne de statut, sections touchées, feuille de route, nombres de tests.
- Code : modules ES pour Node.js 20, sans nouvelle dépendance sans accord ; identifiants en anglais, commentaires et messages en français, comme l'existant.

### 4. Vérifier

- `node skills/geminiboard/scripts/verifier.mjs` : espaces, migrations, version du projecteur, composants, compatibilité avec Node.js 20, fichiers interdits, données sensibles, tests. `--sans-tests` pour une passe rapide.
- Un échec se corrige ; un avertissement se lit, puis se corrige ou se justifie.
- Un changement qui dépend du comportement de Gemini CLI se vérifie sur le vrai Gemini CLI (`references/gemini-cli.md`).

### 5. Livrer

- Pousse la branche et ouvre la PR seulement à la demande de l'humain.
- Description selon le modèle de `references/redaction.md` : objet, changements, points à ratifier, vérifications datées.
- Une PR ne se présente qu'avec la CI au vert, sous Ubuntu et sous Windows (`references/tests.md`).

## Invariants

Ils ne se changent que par une décision ratifiée. Règle, raison, mise en œuvre, contrôle et écarts typiques dans `references/invariants.md`.

| # | Invariant | Contrôle |
|---|---|---|
| 1 | Écrivain unique : seul `board-server` écrit dans la base, par l'enregistreur et le projecteur | revue |
| 2 | Journal `event` en ajout seul ; projections reconstructibles par rejeu ; `PROJECTOR_VERSION` incrémentée quand elles changent | triggers, tests, `verifier.mjs` |
| 3 | Migrations figées : une migration présente sur `main` ne se modifie plus | empreinte à l'ouverture, `verifier.mjs` |
| 4 | Prompt sur l'entrée standard de Gemini CLI : ni argument, ni shell, ni `shell: true` | tests du lanceur |
| 5 | Node.js 20 : toute bibliothèque l'accepte (D10) | `verifier.mjs` |
| 6 | Windows natif et WSL2 (D13) : scripts en Node.js, chemins reconnus à leur forme, pas de `&&` | CI Ubuntu et Windows |
| 7 | Aucun identifiant détenu par le board ; secrets masqués avant écriture ; secrets des serveurs MCP en `$VAR` ; serveur sur `127.0.0.1`, hôte et origine contrôlés | tests du serveur, revue, `verifier.mjs` |
| 8 | Ni le dépôt d'un projet ni les fichiers internes de Gemini CLI ne sont écrits : commandes publiques seulement | revue |
| 9 | Dépôt public : aucune donnée de client, de session ou personnelle ; base jamais versionnée | `verifier.mjs` |
| 10 | Composants portables entre Gemini CLI et Claude Code | `tools/check-components.mjs`, `tools/check-extension.mjs` |

## Références

| Fichier | À lire pour |
|---|---|
| `references/architecture.md` | modules, déroulé d'un tour, événements du journal, où ajouter quoi |
| `references/invariants.md` | les dix invariants en détail |
| `references/gemini-cli.md` | comportements de Gemini CLI 0.65 vérifiés, et comment les revérifier |
| `references/etapes.md` | fiche de chaque étape : livré, reste, à lire |
| `references/tests.md` | suites, faux Gemini CLI, plateformes, CI |
| `references/redaction.md` | français du dépôt, décisions et questions, commits, PR |

## Scripts

| Script | Rôle |
|---|---|
| `scripts/etat.mjs` | état du dépôt, en lecture seule ; `--fichiers` (fichiers modifiés), `--migrations` (empreintes et prochain numéro), `--base <ref>`, `--json` |
| `scripts/verifier.mjs` | contrôles avant une PR, sortie 1 en cas d'échec ; `--sans-tests`, `--base <ref>`, `--node <version>`, `--json` |
| `scripts/depot.mjs` | module commun aux deux scripts (git, README, migrations), sans effet de bord |

`verifier.mjs` lit aussi des motifs locaux, comme des noms de clients, dans un fichier qui ne va jamais dans le dépôt : celui de la variable `GEMINIBOARD_MOTIFS`, à défaut `~/.geminiboard/motifs-interdits.txt` ; un motif par ligne, en texte ou en `/expression/`.

## Commandes et sous-agent

L'extension du dépôt (README, §9.7) apporte ces commandes à Gemini CLI :

| Commande | Effet |
|---|---|
| `/board:etape [n]` | situe le dépôt et propose le plan d'une étape, puis attend l'accord |
| `/board:verifier [--sans-tests]` | lance `verifier.mjs` et explique chaque échec |
| `/board:revue [points]` | fait relire la branche par le sous-agent `relecteur-board` |
| `/board:pr [consignes]` | prépare le titre et la description de la PR, sans rien pousser |
| `/board:migration <objet>` | prépare une nouvelle migration sans toucher aux anciennes |

- Elles lancent les scripts par des injections `!{…}` et demandent d'activer cette skill : en interactif, Gemini CLI demande confirmation pour l'un et l'autre ; en headless, il les refuse, sauf avec la politique `assets/politique-headless.toml`, passée par `--policy`, car une extension ne peut rien autoriser.
- Le sous-agent `relecteur-board` (`agents/relecteur-board.md`) ne fait que lire : confie-lui une revue avec la liste des fichiers modifiés.

## Gemini CLI et Claude Code

Cette skill sert aux deux moteurs (D2).

- Outils de lecture et d'écriture : `read_file`, `write_file`, `replace`, `run_shell_command`, `grep_search`, `glob` sous Gemini CLI ; `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob` sous Claude Code. Correspondance complète au README, §9.7.
- Sous Claude Code, les commandes `/board:*` n'existent pas encore (plugin à l'étape 8) : suis la même méthode et lance les scripts toi-même.
- Propose et lance les commandes une par une, sans `&&` : Windows PowerShell 5.1 ne le connaît pas.

## Ce que tu ne fais jamais

- Modifier une migration présente sur `main`, ou réécrire le journal `event`.
- Passer le prompt en argument de Gemini CLI, ou lancer Gemini CLI par un shell.
- Ajouter une bibliothèque sans accord, ou sans avoir vérifié qu'elle accepte Node.js 20.
- Écrire une donnée de client, un nom, une adresse ou un chemin personnel réels, une clé, un extrait de session réelle.
- Versionner une base SQLite, un `.env` ou un fichier d'identifiants.
- Pousser, forcer un push, fusionner ou ouvrir une PR sans l'accord de l'humain.
- Lancer le spike avec un vrai compte sans accord.
