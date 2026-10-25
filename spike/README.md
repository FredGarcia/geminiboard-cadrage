# Spike de capture (étape 1)

Ce script lance Gemini CLI en mode headless sur des scénarios synthétiques et enregistre le flux `stream-json` brut dans `fixtures/`. Ce corpus répond aux points S1 à S4 du cadrage et servira aux tests du projecteur (étape 2).

## Prérequis

- Node.js 20 ou plus.
- Gemini CLI installé : `npm install -g @google/gemini-cli` (version de référence : 0.65.0).
- Gemini CLI authentifié : lancer `gemini` une fois en interactif pour se connecter, ou définir `GEMINI_API_KEY`.

## Lancement

Depuis la racine du dépôt :

```bash
node spike/capture.mjs
```

| Option | Effet | Défaut |
|---|---|---|
| `--only S1,S3` | ne lance que les scénarios cités | tous |
| `--with-yolo` | ajoute un tour en mode `yolo` (S3 T6), qui exécute `echo` dans le dossier temporaire | absent |
| `--model <nom>` | impose un modèle | modèle par défaut |
| `--timeout <s>` | délai maximal par tour, au-delà duquel le tour est arrêté | 180 |
| `--bin <chemin>` | binaire Gemini CLI | `gemini` |
| `--out <dossier>` | dossier de sortie | `fixtures/` |
| `--keep-workspace` | conserve le dossier de travail temporaire pour l'inspecter | supprimé |

Compter quelques minutes pour 16 tours (17 avec `--with-yolo`) : le spike consomme du quota.

## Ce que fait le script

1. Vérifie Node.js et Gemini CLI (`gemini --version`).
2. Crée un dossier de travail synthétique dans le dossier temporaire du système (`notes.md`, `src/calc.js`). Ce dossier est approuvé pour chaque tour avec `--skip-trust` : c'est toi qui lances le script.
3. Lance les scénarios avec le lanceur du board (`packages/server/src/run-gemini.mjs`) : prompt sur stdin, `--session-id` au premier tour d'une session, `--resume` ensuite.
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

## Constats déjà faits sur Gemini CLI 0.65.0 (sans compte valide)

- Sans authentification : sortie 41 avant tout événement ; le script s'arrête au premier tour (code 3).
- Dossier non approuvé : sortie 55 (d'où `--skip-trust`).
- Erreur d'API : `init`, `message` puis `result` en erreur ; sortie égale au statut HTTP modulo 256 (400 donne 144).
- Après un premier tour en erreur, la session n'existe pas : `--resume` sort avec 42 (« No previous sessions found for this project »).

## Codes de sortie du script

| Code | Sens |
|---|---|
| 0 | spike terminé, rapport écrit |
| 2 | prérequis manquant (Node.js, Gemini CLI) ; rien n'est lancé |
| 3 | arrêt anticipé (authentification, dossier non approuvé, interruption) ; rapport partiel écrit |

## Après le spike

1. Relire `rapport.md` et quelques fichiers `.jsonl`. Les prompts sont synthétiques et les chemins locaux sont masqués (`<WORKSPACE>`, `<HOME>`), mais il faut vérifier qu'aucune donnée personnelle ou de travail n'apparaît.
2. Ajouter le dossier `fixtures/spike-<date>/` dans une branche et ouvrir une PR : sa fusion ratifie l'étape 1.

## Tests

`npm test` à la racine du dépôt fait tourner le spike contre un faux Gemini CLI (`packages/server/test/fake-gemini.mjs`), sans réseau ni compte.
