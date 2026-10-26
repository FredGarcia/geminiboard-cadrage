# Gemini CLI 0.65 : comportements vérifiés

Relevés sur Gemini CLI 0.65.0 (publiée le 20 octobre 2026), dans son code et sur des installations de démonstration, sous Linux et sous Windows, du 24 au 26 octobre 2026. Gemini CLI publie une version par semaine : pour une autre version, revérifier un point avant de bâtir dessus (dernière section). Le README en donne le contexte (§5.5, §6.2, §9.1).

## Lancement headless, comme le board

- `node <paquet>/bundle/gemini.js`, trouvé par `GEMINI_CLI_ENTRY` ou `npm root -g`, sans shell.
- Une entrée standard non interactive fait passer en headless. Elle est lue jusqu'à sa fin, 8 Mo au plus, et tenue pour vide si rien n'arrive dans les 500 ms. `-p` ajoute son texte à l'entrée standard ; un argument positionnel ouvre le mode interactif.
- `--output-format stream-json` : une ligne JSON par événement.
- `GEMINI_CLI_NO_RELAUNCH=true` : pas de second processus. La relance ne sert en headless qu'à agrandir le tas ; sans elle, environ 280 Mo par tour au lieu de 460 sous Linux.
- `NO_BROWSER=true` : sans connexion en cache, sortie 41 (« Manual authorization is required… »). Sans cette variable, sur un poste qui a un navigateur, Gemini CLI demande sur l'entrée standard s'il peut ouvrir la page de connexion et prend le prompt pour la réponse (sortie 42, ou attente si sa première ligne est vide ou vaut « y »).
- `--skip-trust` : sans lui, un dossier non approuvé donne la sortie 55. Le board ne le passe que pour un dossier approuvé par l'humain.
- `GEMINI_CLI_HOME` remplace tout le dossier personnel : réglages, connexion, sessions, extensions. C'est la façon d'isoler un essai.
- Depuis le 18 juin 2026, seuls une licence Gemini Code Assist Standard ou Enterprise (avec `GOOGLE_CLOUD_PROJECT`) et une clé d'API payante sont servis.

## Événements stream-json

Tous portent `type` et `timestamp`.

| Type | Champs |
|---|---|
| `init` | `session_id`, `model` |
| `message` | `role` (`user`, `assistant`), `content`, `delta` |
| `tool_use` | `tool_name`, `tool_id`, `parameters` |
| `tool_result` | `tool_id`, `status` (`success`, `error`), `output`, `error` |
| `error` | `severity` (`warning`, `error`), `message` |
| `result` | `status`, `error` (`type`, `message`), `stats` (`total_tokens`, `input_tokens`, `output_tokens`, `cached`, `input`, `duration_ms`, `tool_calls`, `models`) |

Le message `user` renvoie le prompt tel quel ; pour une commande, la commande brute (« /board:etape 3 »), sans son expansion.

## Codes de sortie et sessions

- 0 succès, 1 erreur générale, 41 authentification, 42 entrée invalide, 52 configuration, 53 limite de tours, 55 dossier non approuvé, 130 annulation.
- Une erreur d'API sort avec le statut HTTP : 400 sous Windows, où les codes tiennent sur 32 bits, 144 ailleurs (400 modulo 256). Seul l'événement `result` fait foi.
- `--session-id <uuid>` crée la session, `--resume <uuid>` la reprend. Une session n'est enregistrée qu'après un tour abouti : après un premier tour en erreur, `--resume` sort avec 42 (« No previous sessions found for this project »).

## Approbation et politiques

- Modes `default`, `auto_edit`, `yolo`, `plan`, choisis avant l'envoi. En headless, toute demande de confirmation devient un refus.
- Règles par défaut du headless (`policies/write.toml` du paquet) : `run_shell_command`, `write_file`, `replace`, `web_fetch` et `activate_skill` sont refusés, sauf règle `allow` d'un niveau plus fort ; `invoke_agent` est autorisé dans les modes `default`, `auto_edit` et `yolo` (`policies/agents.toml`). En interactif, les cinq premiers demandent confirmation.
- Un fichier de politique invalide est refusé en entier : « [USER] Policy file error in <fichier>: Schema validation failed… » sur stderr ; `decision` et `priority` sont obligatoires dans chaque règle.
- Règles TOML `[[rule]]` : `toolName`, `mcpName`, `subagent`, `commandPrefix`, `commandRegex`, `argsPattern`, `modes`, `decision` (`allow`, `deny`, `ask_user`), `priority`.
- `commandPrefix` vise une commande qui commence par le préfixe, suivi d'un blanc ou de rien.
- Niveaux, du plus fort au plus faible : administration, utilisateur, espace de travail, extension, défaut. `--policy` a le niveau utilisateur et **remplace** `~/.gemini/policies`, que le lanceur du board repasse en tête.
- Gemini CLI ignore les règles `allow` d'une extension et ses règles pour le mode `yolo` : une extension ne peut que refuser ou faire demander.
- `--admin-policy` est ignoré quand des politiques système existent. Un fichier de réglages système qui n'appartient pas à root (aux administrateurs sous Windows), ou que d'autres peuvent modifier, est ignoré.

## Shell

- `run_shell_command` passe par bash sous Linux et WSL2, par PowerShell sous Windows (`pwsh.exe`, sinon `powershell.exe`).
- Une politique vise la commande telle que le modèle l'écrit : `ls` existe des deux côtés (alias de `Get-ChildItem`), `grep` pas sous Windows.

## Extensions

- `gemini-extension.json` à la racine : `name`, `version`, `description`, `contextFileName`, `mcpServers` (où `${extensionPath}` est résolu), `excludeTools`.
- Gemini CLI y charge `skills/` (`SKILL.md` et `*/SKILL.md`), `commands/` (récursif), `agents/*.md` (sauf les fichiers qui commencent par `_`), `policies/`, `hooks/hooks.json` et les fichiers de contexte.
- `gemini extensions validate <dossier>` contrôle le manifeste.
- `gemini extensions link <dossier>` n'écrit qu'une métadonnée (`.gemini-extension-install.json`) : ni copie ni lien symbolique. Il demande deux accords sur l'entrée standard, un seul avec `GEMINI_CLI_TRUST_WORKSPACE=true`. Refusé, il sort quand même avec le code 0 : chercher « linked successfully » dans sa sortie.
- Activation par chemin dans `~/.gemini/extensions/extension-enablement.json`, écrite par `gemini extensions enable` et `disable` (`--scope user` ou `workspace`) ; la dernière règle qui correspond l'emporte. `--scope user` ne couvre que le dossier personnel : pour désactiver partout, `disable --scope workspace` depuis la racine de chaque lecteur. Les chemins y sont écrits avec des `/` (`/C:/…` sous Windows).
- `-e <noms>` impose les extensions d'une exécution ; `-e none` n'en charge aucune.
- `gemini extensions list -o json` écrit son JSON sur **stderr**, après d'éventuels messages d'erreur dont les lignes commencent aussi par `[` : chercher la ligne qui ne contient que `[`. Champs : `name`, `version`, `path`, `contextFiles`, `installMetadata`, `isActive` (pour le dossier courant), `id`, `resolvedSettings`, `skills`, `agents`, plus `mcpServers` et `excludeTools` s'ils existent.

## Skills

- Ordre de chargement, le dernier l'emportant à nom égal : intégrées (`skill-creator`, `antigravity-support`), extensions, `~/.gemini/skills`, `~/.agents/skills`, puis `.gemini/skills` et `.agents/skills` du projet, si le dossier est approuvé.
- Frontmatter lu en YAML, avec un repli ligne à ligne si YAML échoue ; seuls `name` et `description` comptent. Dans le nom, les caractères `: \ / < > * ? " |` deviennent `-`.
- Utilisation : outil `activate_skill` (`name`) ; aussi `/nom`, et toujours `/<extension>:nom` pour une skill d'extension.
- Désactivation : `skills.disabled`, cumulé entre portées ; `gemini skills disable`. `gemini skills list` n'a qu'une sortie texte (`<nom> [Enabled]`).

## Sous-agents

- Frontmatter YAML strict : `kind` (`local` par défaut), `name` (`^[a-z0-9-_]+$`), `description` (non vide), `display_name`, `tools`, `mcp_servers`, `model`, `temperature`, `max_turns` et `timeout_mins` (entiers positifs). Toute autre clé est refusée.
- `tools` : outils intégrés, `mcp_<serveur>_<outil>`, `*`.
- Une erreur de chargement s'écrit sur stderr : « [ExtensionManager] Error loading agent from <extension>: Failed to load agent from <fichier>: Validation failed… » ; l'agent n'est pas chargé.
- Agents du projet (`.gemini/agents`) : chargés seulement dans un dossier approuvé, et une fois reconnus par leur empreinte (`~/.gemini/acknowledgments/agents.json`). Un agent d'extension n'a pas à être reconnu.
- Utilisation : outil `invoke_agent` (`agent_name`). `experimental.enableAgents` est vrai par défaut ; un agent se désactive par `agents.overrides.<nom>.enabled`.

## Commandes TOML

- Lues avec `@iarna/toml` (TOML 0.5). Schéma : `prompt`, chaîne obligatoire ; `description`, chaîne facultative ; une autre clé est ignorée sans message.
- Un TOML invalide donne « [FileCommandLoader] Failed to parse TOML file <fichier>: » sur stderr, à chaque chargement, et la commande disparaît. Piège courant : une barre oblique inverse entre guillemets doubles (`"C:\Users"`) ; les chaînes littérales `'''…'''` n'interprètent rien.
- Nom : chemin relatif à `commands/`, avec `:` pour séparateur (`commands/board/etape.toml` donne `/board:etape`) ; caractères hors `[a-zA-Z0-9_.-]` remplacés par `_`. Description coupée à 100 caractères à l'affichage, préfixée par `[<extension>]`. En cas de conflit, renommage en `<extension>:`, `user.`, `workspace.` ou `<serveur MCP>.`.
- `{{args}}` : remplacé tel quel dans le texte ; dans `!{…}`, échappé pour le shell, en un seul argument (rien s'il est vide). Sans `{{args}}`, l'invocation complète est ajoutée à la fin du prompt quand des arguments sont donnés.
- `!{commande}` : lancée par le shell de Gemini CLI, dans son dossier de lancement, avant l'appel au modèle ; accolades équilibrées exigées. Elle passe par les politiques comme `run_shell_command` : refusée, la commande échoue (« … cannot be run. Blocked command: "…". Reason: Blocked by policy. ») ; à confirmer, Gemini CLI demande en interactif et refuse en headless. La sortie est insérée telle quelle, suivie de « [Shell command '…' exited with code N] » si le code n'est pas 0 ; après une commande réussie, la 0.65 ajoute à tort « [Shell command '…' terminated by signal 0] », sans conséquence. Une commande enchaînée (`;`, `&&`, `|`) ou redirigée (`>`) n'est pas couverte par le `commandPrefix` de sa première partie : refusée en headless.
- `@{chemin}` : contenu du fichier ou du dossier inséré, en respectant `.gitignore` et `.geminiignore`, sans passer par les politiques.

## MCP

- Serveurs déclarés dans `mcpServers` (réglages, ou manifeste d'extension) ; leurs outils s'appellent `mcp_<serveur>_<outil>`, coupés au premier `_` : pas de `_` dans un nom de serveur.
- `$VAR`, `${VAR}` et `${VAR:-défaut}` sont résolus depuis l'environnement de Gemini CLI.
- `mcp.allowed`, `mcp.excluded` ; `--allowed-mcp-server-names` remplace `mcp.allowed` pour une exécution. `gemini mcp list` démarre les serveurs pour tester leur connexion : ce n'est pas une lecture sans effet.

## Outils intégrés et réglages

- Outils : `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search` (ancien nom `search_file_content`), `write_file`, `replace`, `run_shell_command`, `web_fetch`, `google_web_search`, `write_todos`, `update_topic`, `activate_skill`, `invoke_agent`, `ask_user`, `enter_plan_mode`, `exit_plan_mode`, `tracker_create_task`, `tracker_update_task`, `tracker_get_task`, `tracker_list_tasks`, `tracker_add_dependency`, `tracker_visualize`, `list_mcp_resources`, `read_mcp_resource`, `get_internal_docs`, `complete_task`.
- Pas d'outil `save_memory` : la mémoire passe par l'édition de `GEMINI.md` et d'un `MEMORY.md` propre au projet.
- Vrais par défaut : `experimental.enableAgents`, `skills.enabled`, `hooksConfig.enabled`, `security.folderTrust.enabled`. La mise à jour automatique ne joue qu'en interactif.

## Vérifier sur le vrai Gemini CLI

- Isoler l'essai : `GEMINI_CLI_HOME` vers un dossier temporaire, `GEMINI_CLI_NO_RELAUNCH=true`, `NO_BROWSER=true`.
- Sans compte, une clé invalide (`GEMINI_API_KEY=cle-invalide`) suffit pour vérifier le lancement, les codes de sortie, le chargement des composants, l'expansion des commandes et les politiques : l'appel au modèle échoue ensuite en 400.
- Scripts du dépôt : `spike/catalogue.mjs` (activation par extension de projet), `tools/check-extension.mjs` (extension du dépôt et commandes `/board:*`), `spike/capture.mjs` avec `--only S4` (lancement, mémoire, masquage).
- Avec un vrai compte : seulement avec l'accord de l'humain, car le quota est consommé, et sans aucune donnée réelle dans les prompts.

## Nouvelle version de Gemini CLI

1. La CI `.github/workflows/gemini-cli.yml` éprouve chaque lundi la dernière version : un échec signale un changement de comportement.
2. Relancer les vérifications ci-dessus avec la nouvelle version.
3. Mettre à jour cette fiche (version, date), le README (§6.2, §9.1) et `GEMINI_CLI_REFERENCE` dans `scripts/depot.mjs`.
