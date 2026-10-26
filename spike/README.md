# Spike de capture (étape 1)

Ce script lance Gemini CLI en mode headless sur des scénarios synthétiques et enregistre le flux `stream-json` brut dans `fixtures/`. Ce corpus répond aux points S1 à S4 du cadrage et servira aux tests du projecteur (étape 2).

## Prérequis

- Node.js 20 ou plus, sous Linux, WSL2 ou Windows natif.
- Gemini CLI installé : `npm install -g @google/gemini-cli` (version de référence : 0.65.0).
- Gemini CLI connecté, avec un accès qu'il sert encore : licence Gemini Code Assist Standard ou Enterprise (compte d'entreprise, avec `GOOGLE_CLOUD_PROJECT`), ou clé d'API payante (`GEMINI_API_KEY`). Depuis le 18 juin 2026, les comptes grand public (gratuit, Google AI Pro et Ultra) ne sont plus servis (README, §5.5). Pour un compte, lancer `gemini` une fois en interactif et se connecter.

## Lancement

Depuis la racine du dépôt (même commande dans PowerShell sous Windows) :

```bash
node spike/capture.mjs
```

Le script lance Gemini CLI comme le board : `node` et son point d'entrée `bundle/gemini.js`, sans shell, avec la relance automatique de Gemini CLI désactivée (`GEMINI_CLI_NO_RELAUNCH`).

| Option | Effet | Défaut |
|---|---|---|
| `--only S1,S3` | ne lance que les scénarios cités | tous |
| `--with-yolo` | ajoute un tour en mode `yolo` (S3 T6), qui exécute `echo` dans le dossier temporaire | absent |
| `--model <nom>` | impose un modèle | modèle par défaut |
| `--timeout <s>` | délai maximal par tour, au-delà duquel le tour est arrêté | 180 |
| `--entry <chemin>` | point d'entrée `gemini.js` de Gemini CLI | trouvé par `npm root -g`, ou variable `GEMINI_CLI_ENTRY` |
| `--bin <commande>` | lance plutôt la commande indiquée (sous Windows, le raccourci `gemini.cmd` passe par `cmd.exe`) | non utilisée |
| `--max-heap <Mo>` | plafonne le tas de Gemini CLI (`--max-old-space-size`) | aucun plafond |
| `--relaunch` | laisse Gemini CLI se relancer dans un second processus, comme il le fait par défaut : pour comparer la mémoire | relance désactivée |
| `--out <dossier>` | dossier de sortie | `fixtures/` |
| `--keep-workspace` | conserve le dossier de travail temporaire pour l'inspecter | supprimé |

Compter quelques minutes pour 16 tours (17 avec `--with-yolo`) : le spike consomme du quota.

## Ce que fait le script

1. Vérifie Node.js et Gemini CLI (`--version`).
2. Crée un dossier de travail synthétique dans le dossier temporaire du système (`notes.md`, `src/calc.js`). Ce dossier est approuvé pour chaque tour avec `--skip-trust` : c'est toi qui lances le script.
3. Lance les scénarios avec le lanceur du board (`packages/server/src/run-gemini.mjs`) : prompt sur stdin, `--session-id` au premier tour d'une session, `--resume` ensuite. Mesure le pic de mémoire de chaque tour.
4. Écrit `fixtures/spike-<date>/` : un fichier `.jsonl` et un fichier `.meta.json` par tour, `rapport.md` et `environnement.json`.
5. Supprime le dossier de travail.

## Scénarios

| Point | Scénario | Ce qu'on observe |
|---|---|---|
| S1 | Corpus : outils, fragments et erreurs | types d'événements, fragments `delta`, appels d'outils de lecture et de recherche, outil en erreur (fichier absent) |
| S2 | Reprise de session | mémoire entre tours avec `--resume` ; deux tours lancés en même temps sur la même session, puis un tour de contrôle |
| S3 | Modes d'approbation et politiques | écriture refusée en `default` et en `plan`, acceptée en `auto_edit` ; shell refusé en `auto_edit`, accepté avec `policy-ls.toml` ; `yolo` en option |
| S4 | Délai de démarrage | délai jusqu'à `init`, jusqu'au premier fragment de réponse et jusqu'à la fin du tour, sur trois tours |

Les contrôles du rapport (OK, KO) comparent le comportement observé au comportement attendu. Un KO n'est pas une erreur du script : c'est un constat à discuter.

La colonne Mémoire de chaque tableau donne le pic de mémoire résidente de Gemini CLI pendant le tour : sous Linux et WSL2, le processus et ses descendants (`/proc`, toutes les 100 ms) ; sous Windows, le processus seul (`tasklist`, toutes les 500 ms), sans les commandes shell qu'il lance. La synthèse en donne la médiane et le maximum.

## Sous Windows

- Gemini CLI exécute les commandes de `run_shell_command` avec PowerShell (`pwsh.exe` s'il est installé, sinon `powershell.exe`). Les tours S3 T4 (`ls`, alias de `Get-ChildItem`) et T6 (`echo`) gardent leur sens, si le modèle écrit bien la commande demandée : la politique `policy-ls.toml` vise le préfixe `ls`, pas `Get-ChildItem`.
- Les chemins sont masqués sous toutes leurs formes : barres inverses ou obliques, échappement JSON, nom court (`JEANDU~1`), casse indifférente.
- Pour comparer avec WSL2 (Q14 du cadrage) : lancer le spike une fois dans chaque environnement et comparer la colonne Mémoire ; la mémoire de la machine virtuelle de WSL2 s'affiche dans le Gestionnaire des tâches, processus `VmmemWSL` (`Vmmem` sur les versions plus anciennes de WSL).

## Constats déjà faits sur Gemini CLI 0.65.0 (sans compte valide)

- Sans authentification : sortie 41 avant tout événement ; le script s'arrête au premier tour (code 3).
- Dossier non approuvé : sortie 55 (d'où `--skip-trust`).
- Erreur d'API : `init`, `message` puis `result` en erreur ; sortie égale au statut HTTP, soit 400 sous Windows et 144 ailleurs (400 modulo 256).
- Après un premier tour en erreur, la session n'existe pas : `--resume` sort avec 42 (« No previous sessions found for this project »).
- Connexion Google sans identifiants en cache : sortie 41, car le lanceur passe `NO_BROWSER=true`. Sans cela, sur un poste qui a un navigateur, Gemini CLI demande sur stdin s'il peut ouvrir la page de connexion, prend le prompt pour la réponse et sort avec 42.
- Mémoire, sous Linux avec Node.js 20.20.2 : 267 à 283 Mo par tour avec la relance désactivée (défaut du spike), 461 à 465 Mo avec `--relaunch`. Sous Windows (CI, Windows Server) : 192 à 222 Mo par tour, processus seul.

## Codes de sortie du script

| Code | Sens |
|---|---|
| 0 | spike terminé, rapport écrit |
| 2 | prérequis manquant (Node.js, Gemini CLI) ; rien n'est lancé |
| 3 | arrêt anticipé (authentification, dossier non approuvé, interruption) ; rapport partiel écrit |

## Après le spike

1. Relire `rapport.md` et quelques fichiers `.jsonl`. Les prompts sont synthétiques ; les chemins locaux (`<WORKSPACE>`, `<REPO>`, `<GEMINI_CLI>`, `<HOME>`) et le nom d'utilisateur (`<USER>`) sont masqués, mais il faut vérifier qu'aucune donnée personnelle ou de travail n'apparaît.
2. Ajouter le dossier `fixtures/spike-<date>/` dans une branche et ouvrir une PR : sa fusion ratifie l'étape 1.

## Tests

`npm test` à la racine du dépôt fait tourner le spike contre un faux Gemini CLI (`packages/server/test/fake-gemini.mjs`), sans réseau ni compte. La CI (GitHub Actions) le fait sous Ubuntu et sous Windows ; elle lance aussi le scénario S4 contre le vrai Gemini CLI avec une clé invalide, puis vérifie les codes de sortie, la mesure de la mémoire et le masquage (`tools/ci-spike-check.mjs`).

## Spike S5 : activation par extension de projet

`spike/catalogue.mjs` vérifie le mécanisme d'activation du catalogue (README, §9.4) sur le vrai Gemini CLI, sans compte ni requête au modèle :

```bash
node spike/catalogue.mjs            # --entry <chemin de gemini.js> pour une autre installation, --keep pour garder les fichiers
```

1. Crée un `GEMINI_CLI_HOME` temporaire : la configuration de l'utilisateur n'est pas touchée.
2. Génère l'extension d'un projet A : une skill, un sous-agent, une commande, une politique (un refus, une autorisation), un serveur MCP, un outil masqué et un fichier de contexte.
3. La valide (`gemini extensions validate`), la lie (`gemini extensions link`, accord donné sur stdin), la désactive depuis la racine de chaque lecteur, puis l'active depuis le dossier du projet A.
4. Regarde, depuis le projet A, un projet B et un dossier du dossier personnel, si l'extension est active et si la skill est visible (`gemini extensions list`, `gemini skills list`).

Attendu : active avec sa skill dans le projet A seulement ; règle d'autorisation de l'extension ignorée ; serveur MCP et outil masqué pris en compte. Code de sortie 0 si tout est conforme, 1 sinon, 2 si Gemini CLI est introuvable. Constaté avec Gemini CLI 0.65.0 sous Linux et sous Windows ; la CI le refait chaque lundi avec la dernière version.
