# Utilitaires : tickets d'un sprint Jira

Outils locaux pour récupérer les tickets du prochain sprint d'un tableau Jira, déposés ici en attendant leur intégration (README du dépôt, Q24). Ils ne font pas partie du board : ils restent hors des espaces de travail npm du dépôt, du `npm test` du board et de la CI, et ont leurs propres contrôles.

## Quel outil choisir

| Cas | Outil | Résultat |
|---|---|---|
| Jira derrière un SSO | `jira-capture-app.mjs`, interface locale (`npm run capture`) | une page MHTML par ticket du sprint, rangée dans le dossier de sa catégorie |
| Le même, sans interface | `jira-capture-mhtml.mjs` (`npm run capture:cli`) | idem |
| Jira sans SSO dont l'API accepte identifiant et mot de passe (Data Center) | `jira-sprint-app.mjs`, interface locale (`npm run export`) | tableau des tickets et CSV |
| Jira Cloud ou Data Center, avec un jeton d'API | `jira_sprint_export.py`, Python 3 | CSV et JSON |

Jira Cloud n'accepte jamais le mot de passe sur son API REST, et un SSO le bloque aussi sur Data Center : sans jeton d'API, la capture des pages par le navigateur est la seule voie.

## Installation

Il faut Node.js 20 ou plus, et Chrome installé sur le poste (ou Edge, voir plus bas). Depuis la racine du dépôt, une commande par ligne :

```
cd utils
npm install
```

`playwright-core` 1.63.0 pilote le navigateur du poste : il n'en télécharge aucun.

## Capturer les tickets d'un sprint derrière un SSO

```
npm run capture
```

Puis ouvrir http://127.0.0.1:3100 et remplir :

- l'adresse de la page du sprint : le backlog pour le prochain sprint (`…/boards/<n>/backlog`), le tableau pour le sprint en cours ;
- le filtre : le préfixe des clés (`ABC` retient `ABCDE-123` et `ABCXY-130`), et les numéros de début et de fin, bornes comprises ; vides, ils retiennent tous les tickets de la page ;
- les catégories, une par ligne : `ticket avec ia` et `ticket sans ia` par défaut ;
- le dossier de sortie : `mhtml` par défaut, relatif à `utils/`, ou un chemin absolu.

Ces valeurs restent dans votre navigateur, en stockage local, pour les fois suivantes. Le préfixe et les numéros propres à votre Jira ne s'écrivent nulle part dans le dépôt.

Ensuite :

1. « Ouvrir le sprint » : le navigateur s'ouvre ; se connecter (SSO, MFA) jusqu'à voir les tickets ;
2. « Capturer les tickets » : l'application fait défiler la page jusqu'à ce qu'aucun ticket nouveau n'apparaisse, relève les liens `/browse/<CLÉ>` retenus par le filtre, puis ouvre et enregistre chaque ticket, un par un. La page suit l'avancement (« Ticket 3 sur 20 »), puis affiche le rapport.

Chaque capture crée un sous-dossier daté :

```
mhtml/capture-2026-10-27_21-30-05/
  sprint.mhtml                     la page du sprint, d'où viennent les liens
  ticket avec ia/ABCDE-123.mhtml   un fichier par ticket, dans le dossier de sa catégorie
  ticket sans ia/ABCXY-130.mhtml
  à classer/ABCDE-127.mhtml        aucun terme clé trouvé, ou plusieurs
  rapport.json                     filtre, catégories, et pour chaque ticket : catégorie, extrait trouvé ou erreur
```

### Classement

La catégorie d'un ticket est le terme clé que contient la page du ticket. La recherche ignore la casse et les accents, et accepte une espace, un tiret, un `_` ou rien entre les mots : « Ticket avec IA », `ticket-avec-ia`, `ticket_avec_ia` et `TicketAvecIA` se valent. Les mots doivent être entiers : « tickets avec ia » ne compte pas.

Le terme est cherché d'abord dans le contenu principal visible de la page, puis dans ses panneaux repliés, puis dans le reste de la page. La navigation de Jira est exclue (filtres enregistrés, éléments récents), car elle peut citer un terme sans rapport avec le ticket. Le premier endroit qui contient un terme décide. S'il en contient un seul, c'est la catégorie ; s'il en contient plusieurs, ou si aucun endroit n'en contient, le ticket va dans `à classer`. Le rapport donne, pour chaque ticket, l'endroit et l'extrait où le terme a été trouvé.

### Erreurs et arrêt

- Une page de ticket qui ne s'affiche pas dans les 20 s compte comme une erreur ; la capture passe au ticket suivant. C'est souvent une session SSO expirée.
- Après trois erreurs de suite, la capture s'arrête.
- Après une erreur ou un arrêt, le navigateur reste ouvert sur le sprint : se reconnecter si besoin, puis relancer. Sans erreur, il se ferme.
- « Fermer le navigateur » arrête une capture en cours ; le rapport partiel reste affiché.

### En ligne de commande

Entrée dans le terminal remplace le bouton « Capturer les tickets » :

```
npm run capture:cli -- "https://votre-org.atlassian.net/jira/software/c/projects/XXX/boards/42/backlog" --prefixe ABC --min 100 --max 200
```

Options : `--prefixe`, `--min`, `--max`, `--categorie` (une par option, répétable ; les deux catégories par défaut sinon) et `--sortie`, relatif au dossier courant.

### Session et navigateur

- La session SSO reste dans `utils/.jira-profile/`, profil dédié du navigateur. Si le SSO pose des cookies persistants, les lancements suivants n'exigent pas de reconnexion ; sinon, on se reconnecte. Ce dossier contient des cookies : il ne se copie ni ne se partage.
- Un profil ne s'ouvre que dans une fenêtre à la fois : fermer le navigateur de l'interface avant de lancer la ligne de commande, et inversement.
- Variables d'environnement :
  - `JIRA_CAPTURE_CHANNEL` : `msedge` pour Edge, `chromium` pour le Chromium de Playwright (`npx playwright install chromium`) ;
  - `JIRA_CAPTURE_PAGE_TIMEOUT_MS` : délai d'affichage d'une page de ticket, 20000 par défaut ;
  - `JIRA_CAPTURE_PROFILE` : autre dossier de profil.

  Sous PowerShell : `$env:JIRA_CAPTURE_CHANNEL = "msedge"` ; sous bash : `export JIRA_CAPTURE_CHANNEL=msedge` ; puis `npm run capture`.
- Sous WSL2, le navigateur doit être installé dans la distribution ; sinon, lancer depuis Windows.

## Exporter par l'API

- `npm run export`, puis http://127.0.0.1:3000 : URL de Jira, identifiant, mot de passe, tableau (nom ou identifiant), sprint. Laissé vide, le sprint est le prochain : celui qui démarre le plus tôt. Les tickets s'affichent, avec un bouton pour télécharger le CSV.
- `python3 jira_sprint_export.py --board "Nom du tableau"` (sous Windows : `py jira_sprint_export.py …`) : l'URL, l'e-mail (vide pour un jeton personnel de Data Center) et le jeton sont lus dans `JIRA_URL`, `JIRA_EMAIL` et `JIRA_TOKEN`, ou demandés à l'invite, jeton masqué. La sortie va dans `utils/exports/`, ou dans le dossier donné par `--out`.
- Le champ d'estimation dépend de l'instance (`customfield_10016` par défaut). On le trouve dans `<URL de Jira>/rest/api/2/field`, puis on le passe dans le champ « Champ d'estimation » de l'interface, ou par `--points-field`.

## Sécurité

- Les outils de capture ne voient aucun identifiant : la connexion se fait dans la fenêtre du navigateur.
- `jira-sprint-app.mjs` transmet le mot de passe à Jira pour la requête en cours, sans l'enregistrer ni le journaliser.
- Les deux interfaces écoutent sur `127.0.0.1` seulement. Comme le serveur du board (README, §11), elles refusent un hôte autre que `127.0.0.1` ou `localhost` et une origine autre que la leur (403), et n'acceptent que du JSON (415) : une page web ouverte dans le navigateur ne peut pas les piloter.
- Le dépôt est public : son `.gitignore` écarte `.jira-profile/`, tout fichier `.mhtml`, `utils/mhtml/` et `utils/exports/`. Une capture ou un export rangés ailleurs dans le dépôt ne sont pas couverts, `rapport.json` compris : les garder hors du dépôt.

## Contrôles

```
npm test
```

`test/run-tests.mjs` vérifie les quatre outils contre un faux Jira local (`test/fake-jira.mjs`), sans réseau ni compte. Le faux Jira sert une API REST Agile paginée, un SSO simulé, un backlog de 72 tickets (chargé au défilement, ou virtualisé) et des pages de tickets qui couvrent chaque cas de classement. Les contrôles portent aussi sur la page de l'interface, pilotée comme par un utilisateur, et sur la sécurité des deux serveurs.

- Le navigateur s'ouvre sur un profil temporaire : la session et les captures de `utils/` ne sont pas touchées.
- Sans Chrome : `JIRA_CAPTURE_CHANNEL=chromium`, après `npx playwright install chromium`. Sous Linux sans écran : `xvfb-run -a npm test`.
- Les contrôles Python sont sautés si Python manque (variable `PYTHON` pour un autre interpréteur).

## Vérifications du 27 octobre 2026

- `npm test`, sous Linux, avec Chrome for Testing 153 et `playwright-core` 1.63.0 : 94 contrôles réussis sur 94, sous Node.js 20.20.2 comme sous 22.23.4.
  - Capture de 8 tickets sur 72 (préfixe, bornes comprises, tri par numéro), en 35 s, avec une liste chargée au défilement ou virtualisée.
  - Classement : terme visible sous quatre graphies, terme dans un panneau replié, aucun terme alors que la navigation en cite un, deux termes ; commentaire chargé au défilement capturé.
  - Session expirée signalée en 3 s par ticket ; arrêt après trois échecs de suite ; arrêt par « Fermer le navigateur » ; session SSO gardée dans le profil.
  - Interface : avancement, rapport, valeurs gardées ; exports par l'API (Node.js et Python) ; contrôles d'hôte, d'origine et de type de contenu.
- À vérifier sur le poste : un vrai Jira derrière le SSO, sous Windows, avec Chrome ; l'endroit où la page d'un ticket affiche « ticket avec ia » ou « ticket sans ia » ; la durée réelle d'une capture d'une vingtaine de tickets.
