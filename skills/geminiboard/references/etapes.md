# Feuille de route : fiches des étapes

La feuille de route fait foi au README, §12 ; ces fiches disent, étape par étape, ce qui est livré, ce qui reste et quoi lire. Chaque étape se termine par une PR dont la fusion ratifie le livrable (D6). Un chemin suivi de « (à venir) » n'existe pas encore.

## Démarrer une étape

1. Mettre `main` à jour, une commande par ligne : `git switch main`, puis `git pull`.
2. Créer la branche : `git switch -c etape-<n>-<objet>`.
3. Si la PR précédente portait des propositions (« (proposé) » au §13), les consigner en décisions (`references/redaction.md`).
4. Lancer `/board:etape <n>` (Gemini CLI), ou suivre la méthode de la skill : situer, puis proposer un plan et attendre l'accord.

## Clore une étape

- Le livrable et son point de ratification sont ceux du README, §12.
- La PR met à jour la ligne de statut du README, la ligne de l'étape au §12 et les nombres de tests (§7.5).
- Ce qui reste à faire après la fusion est écrit dans la ligne de l'étape (« reste … »).

## 0. Cadrage — fait

README v0.2, décisions D1 à D12 (PR #2). Les décisions suivantes s'ajoutent au §2 au fil des PR.

## 1. Spike de capture — reste le corpus réel

- Livré : `spike/capture.mjs` et ses scénarios S1 à S4 (PR #3) ; mesure de la mémoire et Windows natif (PR #5) ; spike S5 du catalogue, `spike/catalogue.mjs` (PR #7).
- Reste, sur le poste de l'humain : lancer le spike avec un vrai compte (licence Gemini Code Assist ou clé payante, README §5.5), relire le rapport et quelques `.jsonl`, puis committer `fixtures/spike-<date>/` dans une PR. Sa fusion ratifie l'étape 1.
- L'agent peut préparer, expliquer et relire le corpus (masquage, absence de données réelles) ; il ne lance pas le spike avec un vrai compte sans accord, car le quota est consommé.
- À lire : `spike/README.md`, README §12 (points S1 à S5).

## 2. Schéma v1 — reste l'ajustement au corpus réel

- Livré : `migrations/001_init.sql`, `packages/server/src/journal.mjs`, `packages/server/src/recorder.mjs`, `packages/server/src/projector.mjs` et le rejeu des corpus (PR #4 à #7).
- Reste, une fois le corpus réel committé : le rejouer (`packages/server/test/corpus.test.mjs` le prend en compte de lui-même), relever les écarts (types d'événements, champs, ordre des fragments), corriger les règles de projection (`PROJECTOR_VERSION` + 1) et, si le schéma doit changer, écrire une migration 002 (`/board:migration`). Sa fusion ratifie le schéma v1.
- À lire : README §6.2 et §7, `fixtures/README.md`, `references/invariants.md` (invariants 2 et 3).

## 3. Skill de construction — en cours (PR #8)

- Livrable : cette skill (`skills/geminiboard/SKILL.md`, ses références et ses scripts), les commandes `/board:*` (`commands/board/`), le sous-agent `agents/relecteur-board.md`, l'extension du dépôt (`gemini-extension.json`, `AGENTS.md`) et les contrôles `tools/check-components.mjs` et `tools/check-extension.mjs`.
- Ratification : skill 1.0.0 (version de `gemini-extension.json`).
- Toute évolution de la skill passe ensuite par une PR qui incrémente cette version : correctif 1.0.1, ajout 1.1.0.

## 4. Serveur

- Livrable :
  - `packages/server/src/server.mjs` (à venir), d'après l'esquisse du README, §6.3 : Fastify 5.12.7, `@fastify/websocket` 11.3.4, `light-my-request` épinglé en 6.6.0 (`overrides`), écoute sur `127.0.0.1` ;
  - API REST et WebSocket du README, §5.2 (`/api/projects`, `/api/conversations`, `/api/conversations/:id/timeline`, `/api/artifacts`, `/api/components`, `/api/events`, `/api/search` ; messages `prompt` et `cancel`, puis `turn.start`, `event`, `turn.end`, `turn.error`) ;
  - instantanés des artefacts : relecture du fichier après un `write_file` ou un `replace` réussi, écrite par `rec.snapshot` ;
  - masquage des secrets avant écriture (README, §11) ;
  - inventaire du catalogue en lecture (README, §9.2 ; D14, D18) : Gemini CLI et Claude Code, sans rien lancer (pas de `gemini mcp list`), journalisé en `catalog.scan`.
- Ratification : une discussion de bout en bout ; l'inventaire du poste.
- Questions en jeu : Q7 (rétention du journal), Q8 (capture par défaut), Q11 (mode d'approbation par défaut).
- Tests : serveur contre le faux Gemini CLI, sur le modèle des 25 contrôles de l'esquisse (README, §6.3) ; mémoire au repos mesurée.

## 5. Interface

- Préalable : trancher Q3 (Angular 20 ou 21 ; la 22 est exclue par D10) et Q4 (Angular CDK et composants maison).
- Livrable : `packages/ui` (à venir) : barre latérale, fil en continu, choix du mode d'approbation, panneau d'artefacts, page Catalogue en lecture (listes, fiches, usages ; README §9.6).
- Accessibilité (O5, RGAA 4.1 et WCAG 2.2 niveau AA) : tout au clavier, focus géré entre panneaux et dialogues, flux annoncé phrase par phrase (`aria-live="polite"`), contrastes AA, thèmes clair et sombre, `prefers-reduced-motion`.
- Ratification : parcours au clavier et au lecteur d'écran ; tests de bout en bout Playwright.

## 6. Catalogue et capture passive

- Livrable :
  - cycle de vie des composants, contrôles, ratification et adoption (README, §9.3) ;
  - extension de projet `gb-<projet>` (README, §9.4 ; D15, D16, D17) : génération, liaison, activation par les commandes publiques, épinglage, politiques par `--policy` ;
  - agents de projet non reconnus signalés ;
  - migration `migrations/002_catalogue.sql` (à venir), d'après l'esquisse du README, §9.6 ;
  - relais de hooks `packages/hook` (à venir), livré dans les extensions de projet (README, §6.4) ;
  - import des sessions de `~/.gemini/tmp/<hash>/chats`.
- Ratification : catalogue v1 ; O1 vérifié (une session lancée dans un terminal apparaît dans la base).

## 7. Lecture par Claude

- Livrable : `packages/mcp` (à venir), serveur MCP en lecture seule (README, §8) ; skill `geminiboard-journal` ; export Markdown filtré.
- Ratification : O3 vérifié (Claude répond à « qu'a-t-on décidé sur X ? »).

## 8. Portabilité et ACP

- Livrable : `tools/port.mjs` (à venir) : source neutre des sous-agents, variantes Gemini et Claude générées, commandes Markdown générées depuis le TOML, plugin `claude-plugin/` et marketplace (README, §9.7) ; ACP pour les autorisations en cours de tour et pour le moteur Claude, qui exige Node.js 22 (Q9, Q12).
- Ratification : O4 vérifié (un composant s'installe dans les deux moteurs depuis ce dépôt).
