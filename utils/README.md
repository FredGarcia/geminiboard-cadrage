# Utilitaires : tickets d'un sprint Jira

Outils locaux pour récupérer les tickets du prochain sprint d'un tableau Jira, déposés ici en attendant leur intégration (README du dépôt, Q24). Ils ne font pas partie du board : ils restent hors des espaces de travail npm du dépôt, de `npm test` et de la CI.

## Quel outil choisir

| Cas | Outil | Résultat |
|---|---|---|
| Jira derrière un SSO | `jira-capture-app.mjs`, interface locale (`npm run capture`) | la page du sprint en MHTML, comme « Enregistrer sous… » dans Chrome |
| Le même, sans interface | `jira-capture-mhtml.mjs` (`npm run capture:cli`) | la page du sprint en MHTML |
| Jira sans SSO dont l'API accepte identifiant et mot de passe (Data Center) | `jira-sprint-app.mjs`, interface locale (`npm run export`) | tableau des tickets et CSV |
| Jira Cloud ou Data Center, avec un jeton d'API | `jira_sprint_export.py`, Python 3 | CSV et JSON |

Jira Cloud n'accepte jamais le mot de passe sur son API REST, et un SSO le bloque aussi sur Data Center : sans jeton d'API, la capture de la page par le navigateur est la seule voie.

## Installation

Il faut Node.js 20 ou plus, et Chrome installé sur le poste (ou Edge, voir plus bas). Depuis la racine du dépôt, une commande par ligne :

```
cd utils
npm install
```

`playwright-core` 1.63.0 pilote le navigateur du poste : il n'en télécharge aucun.

## Capturer un sprint derrière un SSO

```
npm run capture
```

Puis ouvrir http://127.0.0.1:3100 :

1. coller l'adresse de la page du sprint : le backlog pour le prochain sprint (`…/boards/<n>/backlog`), le tableau pour le sprint en cours ;
2. choisir le dossier de sortie : `mhtml` par défaut, relatif à `utils/`, ou un chemin absolu ;
3. « Ouvrir le sprint » : le navigateur s'ouvre ; se connecter (SSO, MFA) jusqu'à voir les tickets ;
4. « Capturer » : l'application fait défiler la page jusqu'à ce qu'aucun ticket nouveau n'apparaisse pendant quatre pas, revient en haut, enregistre `sprint-<date>.mhtml` et ferme le navigateur.

Le bilan donne deux nombres : les tickets repérés pendant le défilement, et ceux présents dans la capture. Ce sont les clés distinctes des liens `/browse/<CLÉ>`, épopées parentes comprises. S'ils diffèrent, la page retire de l'affichage les cartes sorties de l'écran : réduire le zoom du navigateur (Ctrl -) pour en afficher davantage à la fois, puis recommencer.

En ligne de commande, Entrée dans le terminal remplace le bouton « Capturer » ; un second argument donne le dossier de sortie, relatif au dossier courant :

```
npm run capture:cli -- "https://votre-org.atlassian.net/jira/software/c/projects/XXX/boards/42/backlog"
```

### Session et navigateur

- La session SSO reste dans `utils/.jira-profile/`, profil dédié du navigateur. Si le SSO pose des cookies persistants, les lancements suivants n'exigent pas de reconnexion ; sinon, on se reconnecte. Ce dossier contient des cookies : il ne se copie ni ne se partage.
- Un profil ne s'ouvre que dans une fenêtre à la fois : fermer le navigateur de l'interface avant de lancer la ligne de commande, et inversement.
- Pour un autre navigateur, utiliser la variable `JIRA_CAPTURE_CHANNEL` : `msedge` pour Edge, `chromium` pour le Chromium de Playwright (`npx playwright install chromium`). Sous PowerShell : `$env:JIRA_CAPTURE_CHANNEL = "msedge"` ; sous bash : `export JIRA_CAPTURE_CHANNEL=msedge` ; puis `npm run capture`.
- Sous WSL2, le navigateur doit être installé dans la distribution ; sinon, lancer depuis Windows.

## Exporter par l'API

- `npm run export`, puis http://127.0.0.1:3000 : URL de Jira, identifiant, mot de passe, tableau (nom ou identifiant), sprint. Laissé vide, le sprint est le prochain : celui qui démarre le plus tôt. Les tickets s'affichent, avec un bouton pour télécharger le CSV.
- `python3 jira_sprint_export.py --board "Nom du tableau"` (sous Windows : `py jira_sprint_export.py …`) : l'URL, l'e-mail (vide pour un jeton personnel de Data Center) et le jeton sont lus dans `JIRA_URL`, `JIRA_EMAIL` et `JIRA_TOKEN`, ou demandés à l'invite, jeton masqué. La sortie va dans `utils/exports/`, ou dans le dossier donné par `--out`.
- Le champ d'estimation dépend de l'instance (`customfield_10016` par défaut). On le trouve dans `<URL de Jira>/rest/api/2/field`, puis on le passe dans le champ « Champ d'estimation » de l'interface, ou par `--points-field`.

## Sécurité

- Les outils de capture ne voient aucun identifiant : la connexion se fait dans la fenêtre du navigateur.
- `jira-sprint-app.mjs` transmet le mot de passe à Jira pour la requête en cours, sans l'enregistrer ni le journaliser.
- Les deux interfaces écoutent sur `127.0.0.1` seulement. Comme le serveur du board (README, §11), elles refusent un hôte autre que `127.0.0.1` ou `localhost` et une origine autre que la leur (403), et n'acceptent que du JSON (415) : une page web ouverte dans le navigateur ne peut pas les piloter.
- Le dépôt est public : son `.gitignore` écarte `.jira-profile/`, tout fichier `.mhtml`, `utils/mhtml/` et `utils/exports/`. Une capture ou un export rangés ailleurs dans le dépôt ne sont pas couverts : les garder hors du dépôt.

## Vérifications du 27 octobre 2026

- Contre un faux Jira local, sous Linux, avec Chrome for Testing 153 piloté par `playwright-core` 1.63.0 : 40 contrôles réussis sur 40, sous Node.js 20.20.2 comme sous 22.23.4.
  - API REST Agile paginée : prochain sprint, 120 tickets sur trois pages, description ADF, tableau ambigu, mot de passe ou jeton refusé ; Basic et Bearer pour le script Python.
  - Page de backlog derrière une redirection SSO, en deux variantes. Avec chargement au défilement : 96 tickets vus, 96 capturés, en 7,3 s. Avec affichage virtualisé : 96 vus, 22 capturés, écart signalé, premières cartes capturées.
  - Session gardée dans le profil ; contrôles d'hôte, d'origine et de type de contenu ; profil, captures et exports ignorés par git.
- À vérifier sur le poste : un vrai Jira derrière le SSO, sous Windows, avec Chrome ; le comportement réel du backlog (chargement au défilement ou affichage virtualisé) ; la persistance de la session, qui dépend du SSO.
