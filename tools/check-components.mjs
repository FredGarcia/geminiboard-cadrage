#!/usr/bin/env node
// check-components.mjs : contrôle les composants portables du dépôt (README, §9.3), sans Gemini CLI :
//   extension  gemini-extension.json : nom, version, fichier de contexte ; AGENTS.md et ses renvois
//   skills     skills/<nom>/SKILL.md : frontmatter limité à name et description, nom égal au dossier,
//              fichiers cités présents, références et scripts tous cités par SKILL.md, scripts lisibles par Node.js
//   commandes  commands/<ns>/<nom>.toml : TOML valide (sous-ensemble : chaînes, nombres, booléens,
//              tableaux, [[tables]]), clés prompt et description seulement, {{args}}, !{…} et @{…} bien
//              formés, commande shell de !{…} autorisée par une politique du dépôt (skills/*/assets/*.toml)
//   sous-agents agents/<nom>.md : frontmatter strict de Gemini CLI 0.65, nom égal au fichier, outils connus
// Le contrôle de référence reste celui du vrai Gemini CLI (tools/check-extension.mjs, en CI).
// Usage : node tools/check-components.mjs [--racine <dossier>] [--json] ; sortie 0 si conforme, 1 sinon.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// Outils intégrés de Gemini CLI 0.65.0 (ALL_BUILTIN_TOOL_NAMES), plus l'alias historique de grep_search
export const KNOWN_TOOLS = new Set([
  'glob', 'write_todos', 'write_file', 'google_web_search', 'web_fetch', 'replace', 'run_shell_command',
  'grep_search', 'read_many_files', 'read_file', 'list_directory', 'activate_skill', 'ask_user',
  'tracker_create_task', 'tracker_update_task', 'tracker_get_task', 'tracker_list_tasks',
  'tracker_add_dependency', 'tracker_visualize', 'get_internal_docs', 'enter_plan_mode', 'exit_plan_mode',
  'update_topic', 'complete_task', 'invoke_agent', 'read_mcp_resource', 'list_mcp_resources',
  'search_file_content',
]);
// Clés acceptées par Gemini CLI 0.65 dans le frontmatter d'un sous-agent local (schéma strict)
export const AGENT_KEYS = new Set(['kind', 'name', 'description', 'display_name', 'tools', 'mcp_servers', 'model',
  'temperature', 'max_turns', 'timeout_mins']);
const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // Agent Skills, Claude Code et Gemini CLI
const isKnownTool = (t) => KNOWN_TOOLS.has(t) || t === '*' || t === 'mcp_*'
  || /^mcp_[a-z0-9.:-]+_(?:\*|[a-z0-9_.:-]*[a-z0-9.:-][a-z0-9_.:-]*)$/i.test(t);

// ---------------------------------------------------------------------------------------------
// TOML (sous-ensemble) : de quoi lire les commandes et les politiques, et refuser ce qui en sort.
// ---------------------------------------------------------------------------------------------
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/** Analyse un TOML. Rend { root, tables: [{ name, array, values, line }], errors: [{ line, message }] }. */
export function parseToml(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const errors = [];
  const root = { name: null, array: false, values: {}, line: 1 };
  const tables = [];
  let current = root;
  let i = 0;
  let line = 1;
  const fail = (message) => { errors.push({ line, message }); };
  const peek = (s) => src.startsWith(s, i);
  const skipSpaces = () => { while (src[i] === ' ' || src[i] === '\t') i++; };
  const skipToEol = () => { while (i < src.length && src[i] !== '\n') i++; };
  const advance = (n = 1) => { for (let k = 0; k < n; k++) { if (src[i] === '\n') line++; i++; } };

  function readEscape() { // après « \ »
    const c = src[i];
    if (c in ESCAPES) { i++; return ESCAPES[c]; }
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8;
      const hex = src.slice(i + 1, i + 1 + len);
      if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) throw new Error(`échappement \\${c} invalide : ${len} chiffres hexadécimaux attendus`);
      i += 1 + len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    throw new Error(`échappement invalide « \\${c ?? ''} » (une barre oblique inverse s'écrit \\\\ ; ou chaîne littérale '''…''')`);
  }

  function readString() {
    if (peek('"""') || peek("'''")) {
      const q = src[i];
      const delim = q.repeat(3);
      advance(3);
      if (src[i] === '\n') advance();
      let out = '';
      for (;;) {
        if (i >= src.length) throw new Error(`chaîne ${delim} non fermée`);
        if (peek(delim)) {
          let extra = 0; // jusqu'à deux guillemets collés au délimiteur de fin appartiennent à la chaîne
          while (extra < 2 && src[i + 3 + extra] === q) extra++;
          out += q.repeat(extra);
          advance(3 + extra);
          return out;
        }
        if (q === '"' && src[i] === '\\') {
          i++;
          if (/^[ \t]*\n/.test(src.slice(i))) { // barre en fin de ligne : saute les blancs suivants
            while (/[ \t\n]/.test(src[i] ?? '')) advance();
            continue;
          }
          out += readEscape();
          continue;
        }
        out += src[i];
        advance();
      }
    }
    const q = src[i];
    i++;
    let out = '';
    for (;;) {
      const c = src[i];
      if (c === undefined || c === '\n') throw new Error('chaîne non fermée sur sa ligne');
      if (c === q) { i++; return out; }
      if (q === '"' && c === '\\') { i++; out += readEscape(); continue; }
      out += c;
      i++;
    }
  }

  function readValue() {
    const c = src[i];
    if (c === '"' || c === "'") return readString();
    if (c === '[') {
      advance();
      const arr = [];
      for (;;) {
        while (/[ \t\n]/.test(src[i] ?? '')) advance();
        if (src[i] === '#') { skipToEol(); continue; }
        if (src[i] === ']') { advance(); return arr; }
        if (i >= src.length) throw new Error('tableau non fermé');
        arr.push(readValue());
        while (/[ \t\n]/.test(src[i] ?? '')) advance();
        if (src[i] === '#') { skipToEol(); continue; }
        if (src[i] === ',') { advance(); continue; }
        if (src[i] !== ']') throw new Error('« , » ou « ] » attendu dans le tableau');
      }
    }
    if (c === '{') throw new Error('table en ligne non prise en charge par ce contrôle');
    const m = src.slice(i).match(/^(true|false|[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?=[ \t,\]\n#]|$)/);
    if (!m) throw new Error('valeur attendue : chaîne, nombre, booléen ou tableau');
    i += m[1].length;
    return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1].replace(/_/g, ''));
  }

  while (i < src.length) {
    skipSpaces();
    if (src[i] === '\n') { advance(); continue; }
    if (src[i] === '#' || i >= src.length) { skipToEol(); continue; }
    try {
      if (src[i] === '[') {
        const m = src.slice(i).match(/^(\[\[?)[ \t]*([A-Za-z0-9_-]+)[ \t]*(\]\]?)/);
        if (!m || m[1].length !== m[3].length) throw new Error('en-tête de table invalide');
        current = { name: m[2], array: m[1] === '[[', values: {}, line };
        if (!current.array && tables.some((t) => t.name === current.name && !t.array)) throw new Error(`table [${m[2]}] définie deux fois`);
        tables.push(current);
        i += m[0].length;
      } else {
        const k = src.slice(i).match(/^(?:([A-Za-z0-9_-]+)|"([^"\\\n]*)")[ \t]*=/);
        if (!k) throw new Error(src.slice(i).match(/^[A-Za-z0-9_-]+\./) ? 'clé pointée non prise en charge par ce contrôle' : 'clé = valeur attendue');
        const key = k[1] ?? k[2];
        i += k[0].length;
        skipSpaces();
        const startLine = line;
        const value = readValue();
        if (Object.hasOwn(current.values, key)) { line = startLine; throw new Error(`clé « ${key} » définie deux fois`); }
        current.values[key] = value;
      }
      skipSpaces();
      if (src[i] === '#') skipToEol();
      if (i < src.length && src[i] !== '\n') throw new Error('fin de ligne attendue après la valeur');
    } catch (e) {
      fail(e.message);
      skipToEol();
    }
  }
  return { root: root.values, tables, errors };
}

// ---------------------------------------------------------------------------------------------
// Frontmatter YAML (sous-ensemble) : scalaires, chaînes entre guillemets, listes, blocs > et |.
// ---------------------------------------------------------------------------------------------
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/; // comme Gemini CLI (skillLoader, agentLoader)

function yamlScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const m = s.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (!m) throw new Error('chaîne entre guillemets mal fermée');
    return m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[c] ?? c));
  }
  if (s.startsWith("'")) {
    const m = s.match(/^'((?:[^']|'')*)'$/);
    if (!m) throw new Error('chaîne entre apostrophes mal fermée');
    return m[1].replace(/''/g, "'");
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error('liste en ligne mal fermée');
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => yamlScalar(x)) : [];
  }
  if (/^[{&*!|>%@`]/.test(s)) throw new Error(`valeur non prise en charge par ce contrôle : ${s}`);
  const plain = s.replace(/\s+#.*$/, '');
  if (plain === 'true' || plain === 'false') return plain === 'true';
  if (plain === '' || plain === 'null' || plain === '~') return null;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(plain)) return Number(plain);
  if (/:\s/.test(plain)) throw new Error(`« : » dans une valeur sans guillemets : ${plain}`);
  return plain;
}

/** Sépare et lit le frontmatter. Rend { data, body, errors } ; data null sans frontmatter. */
export function parseFrontmatter(text) {
  const m = String(text).match(FRONTMATTER);
  if (!m) return { data: null, body: String(text), errors: [{ line: 1, message: 'frontmatter absent (le fichier doit commencer par ---)' }] };
  const lines = m[1].split(/\r?\n/);
  const data = {};
  const errors = [];
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (/^\t/.test(l)) { errors.push({ line: n + 2, message: 'tabulation en début de ligne' }); continue; }
    const kv = l.match(/^([A-Za-z_][\w-]*):(?:\s(.*))?$/);
    if (!kv) { errors.push({ line: n + 2, message: `ligne inattendue : ${l.trim()}` }); continue; }
    const [, key, rest = ''] = kv;
    if (Object.hasOwn(data, key)) errors.push({ line: n + 2, message: `clé « ${key} » répétée` });
    const value = rest.trim();
    try {
      if (/^[>|][-+]?$/.test(value)) { // bloc replié (>) ou littéral (|)
        const block = [];
        while (n + 1 < lines.length && (/^\s+\S/.test(lines[n + 1]) || !lines[n + 1].trim())) block.push(lines[++n].trim());
        while (block.length && !block.at(-1)) block.pop();
        data[key] = value.startsWith('>') ? block.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : block.join('\n');
      } else if (value === '' || value.startsWith('#')) { // liste en blocs, ou table imbriquée
        const items = [];
        let nested = false;
        while (n + 1 < lines.length && (/^\s+\S/.test(lines[n + 1]) || /^-\s/.test(lines[n + 1]))) {
          const item = lines[++n].match(/^\s*-\s+(.*)$/);
          if (item) items.push(yamlScalar(item[1]));
          else nested = true;
        }
        data[key] = nested ? { nonControle: true } : (items.length ? items : null);
      } else data[key] = yamlScalar(value);
    } catch (e) {
      errors.push({ line: n + 2, message: e.message });
    }
  }
  return { data, body: m[2] ?? '', errors };
}

// ---------------------------------------------------------------------------------------------
// Injections des commandes, comme Gemini CLI 0.65 (injectionParser) : accolades équilibrées.
// ---------------------------------------------------------------------------------------------
export function extractInjections(prompt, trigger) {
  const found = [];
  let index = 0;
  for (;;) {
    const start = prompt.indexOf(trigger, index);
    if (start < 0) return found;
    let depth = 1;
    let k = start + trigger.length;
    for (; k < prompt.length && depth > 0; k++) {
      if (prompt[k] === '{') depth++;
      else if (prompt[k] === '}') depth--;
    }
    if (depth > 0) throw new Error(`« ${trigger} » ouvert sans accolade fermante (position ${start})`);
    found.push(prompt.slice(start + trigger.length, k - 1).trim());
    index = k;
  }
}

/**
 * La politique (règle allow sur run_shell_command, commandPrefix) couvre-t-elle cette commande ?
 * Comme Gemini CLI 0.65 : préfixe suivi d'un blanc ou de rien ; une commande enchaînée (;, &&, ||, |),
 * redirigée (<, >) ou substituée (`…`, $(…)) n'est pas couverte, chaque partie étant contrôlée à part.
 */
export function prefixCovers(prefix, command) {
  if (/[;&|<>`]|\$\(/.test(command)) return false;
  return command === prefix || (command.startsWith(prefix) && /[\s"]/.test(command[prefix.length]));
}

// ---------------------------------------------------------------------------------------------
// Contrôles
// ---------------------------------------------------------------------------------------------
const ROOT_PATHS = /^(?:skills|commands|agents|packages|tools|migrations|spike|fixtures|\.github)\/[\w.\/-]+$|^(?:README\.md|AGENTS\.md|package\.json|gemini-extension\.json)$/;
const SKILL_PATHS = /^(?:references|scripts|assets)\/[\w.\/-]+$/;
const PLANNED = /\(à venir\)/; // un chemin prévu, pas encore présent, se signale ainsi sur sa ligne

/** Chemins cités entre accents graves, avec leur ligne : [{ path, line, planned }]. */
export function citedPaths(text) {
  const out = [];
  String(text).split('\n').forEach((l, n) => {
    for (const [, token] of l.matchAll(/`([^`\s]+)`/g)) out.push({ path: token.replace(/^\.\//, ''), line: n + 1, planned: PLANNED.test(l) });
  });
  return out;
}

const listFiles = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : [p];
  });
};
const rel = (root, p) => relative(root, p).split(sep).join('/');

/** Contrôle les composants sous `root`. Rend [{ type, name, path, errors, warnings }]. */
export function checkComponents(root) {
  const results = [];
  const result = (type, name, path) => {
    const r = { type, name, path, errors: [], warnings: [] };
    results.push(r);
    return r;
  };
  const checkCitations = (r, text, { skillDir } = {}) => {
    for (const c of citedPaths(text)) {
      if (c.planned) continue;
      let base = null;
      if (skillDir && SKILL_PATHS.test(c.path)) base = skillDir;
      else if (ROOT_PATHS.test(c.path)) base = root;
      if (base && !existsSync(join(base, c.path))) r.errors.push(`ligne ${c.line} : \`${c.path}\` cité mais absent`);
    }
  };

  // Extension du dépôt
  const manifestPath = join(root, 'gemini-extension.json');
  if (existsSync(manifestPath)) {
    const r = result('extension', null, 'gemini-extension.json');
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { r.errors.push(`JSON invalide : ${e.message}`); }
    if (manifest) {
      r.name = manifest.name ?? null;
      if (!PORTABLE_NAME.test(String(manifest.name ?? ''))) r.errors.push('name : minuscules, chiffres et tirets');
      if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version ?? ''))) r.errors.push('version : numéro semver (1.0.0) attendu');
      if (!String(manifest.description ?? '').trim()) r.warnings.push('description absente');
      for (const name of Object.keys(manifest.mcpServers ?? {})) {
        if (name.includes('_')) r.errors.push(`serveur MCP « ${name} » : pas de _ dans le nom (outils mcp_<serveur>_<outil>)`);
      }
      const context = manifest.contextFileName;
      for (const file of Array.isArray(context) ? context : context ? [context] : []) {
        if (!existsSync(join(root, file))) r.errors.push(`contextFileName : ${file} absent`);
        else checkCitations(r, readFileSync(join(root, file), 'utf8'));
      }
    }
  }

  // Politiques du dépôt : règles allow de run_shell_command, pour les injections !{…}
  const allowPrefixes = [];
  for (const file of listFiles(join(root, 'skills')).filter((f) => /[\\/]assets[\\/][^\\/]+\.toml$/.test(f))) {
    const r = result('politique', basename(file, '.toml'), rel(root, file));
    const { tables, errors } = parseToml(readFileSync(file, 'utf8'));
    for (const e of errors) r.errors.push(`ligne ${e.line} : ${e.message}`);
    const rules = tables.filter((t) => t.name === 'rule' && t.array);
    if (!rules.length && !errors.length) r.errors.push('aucune règle [[rule]]');
    for (const t of rules) {
      const v = t.values;
      if (!v.toolName && !v.mcpName) r.errors.push(`règle de la ligne ${t.line} : toolName ou mcpName attendu`);
      if (!['allow', 'deny', 'ask_user'].includes(v.decision)) r.errors.push(`règle de la ligne ${t.line} : decision = allow, deny ou ask_user`);
      if (!Number.isInteger(v.priority)) r.errors.push(`règle de la ligne ${t.line} : priority entière obligatoire (Gemini CLI refuse le fichier sans elle)`);
      for (const k of ['argsPattern', 'commandRegex']) {
        if (v[k] === undefined) continue;
        try { new RegExp(String(v[k])); } catch (e) { r.errors.push(`règle de la ligne ${t.line} : ${k} n'est pas une expression régulière valide (${e.message})`); }
      }
      if (v.toolName === 'run_shell_command' && v.decision === 'allow' && v.commandPrefix) {
        allowPrefixes.push(...[v.commandPrefix].flat().map(String));
      }
    }
  }

  // Skills
  const skillsDir = join(root, 'skills');
  for (const dir of existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : []) {
    const skillDir = join(skillsDir, dir.name);
    const file = join(skillDir, 'SKILL.md');
    const r = result('skill', dir.name, rel(root, file));
    if (!existsSync(file)) { r.errors.push('SKILL.md absent'); continue; }
    const text = readFileSync(file, 'utf8');
    const { data, body, errors } = parseFrontmatter(text);
    for (const e of errors) r.errors.push(`frontmatter, ligne ${e.line} : ${e.message}`);
    if (data) {
      const extra = Object.keys(data).filter((k) => k !== 'name' && k !== 'description');
      if (extra.length) r.errors.push(`frontmatter : ${extra.join(', ')} en trop ; name et description seulement, pour rester portable`);
      if (data.name !== dir.name) r.errors.push(`name « ${data.name} » différent du dossier « ${dir.name} »`);
      if (!PORTABLE_NAME.test(String(data.name ?? '')) || String(data.name).length > 64) r.errors.push('name : 64 caractères au plus, minuscules, chiffres et tirets');
      const description = typeof data.description === 'string' ? data.description.trim() : '';
      if (!description) r.errors.push('description absente');
      if (description.length > 1024) r.errors.push(`description de ${description.length} caractères (1024 au plus)`);
      if (/[<>]/.test(description)) r.errors.push('description : pas de chevrons < >');
    }
    if (!body.trim()) r.errors.push('corps vide');
    const lines = body.split('\n').length;
    if (lines > 500) r.warnings.push(`corps de ${lines} lignes : au-delà de 500, déplacer le détail dans references/`);
    checkCitations(r, body, { skillDir });
    const cited = new Set(citedPaths(body).map((c) => c.path));
    for (const sub of ['references', 'scripts', 'assets']) {
      for (const f of listFiles(join(skillDir, sub))) {
        const p = rel(skillDir, f);
        if (sub === 'scripts' && p.split('/').length > 2) continue; // tests ou données des scripts
        if (!cited.has(p)) r.errors.push(`\`${p}\` jamais cité par SKILL.md : la skill ne le lira pas`);
      }
    }
    for (const f of listFiles(join(skillDir, 'references')).filter((x) => x.endsWith('.md'))) {
      const sub = result('référence', `${dir.name}/${rel(skillDir, f)}`, rel(root, f));
      checkCitations(sub, readFileSync(f, 'utf8'), { skillDir });
    }
    for (const f of listFiles(join(skillDir, 'scripts')).filter((x) => /\.m?js$/.test(x))) {
      const s = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true });
      if (s.status !== 0) r.errors.push(`\`${rel(skillDir, f)}\` : erreur de syntaxe (${(s.stderr ?? '').split('\n').find((l) => /Error/.test(l)) ?? 'node --check'})`);
    }
  }

  // Commandes
  const commandsDir = join(root, 'commands');
  for (const file of listFiles(commandsDir).filter((f) => f.endsWith('.toml'))) {
    const name = `/${rel(commandsDir, file).replace(/\.toml$/, '').split('/').join(':')}`;
    const r = result('commande', name, rel(root, file));
    const { root: values, tables, errors } = parseToml(readFileSync(file, 'utf8'));
    for (const e of errors) r.errors.push(`ligne ${e.line} : ${e.message}`);
    if (tables.length) r.errors.push('tables inattendues : une commande ne contient que prompt et description');
    const extra = Object.keys(values).filter((k) => k !== 'prompt' && k !== 'description');
    if (extra.length) r.errors.push(`clés inconnues : ${extra.join(', ')} (Gemini CLI les ignore ; elles ne passent pas à Claude Code)`);
    if (typeof values.prompt !== 'string' || !values.prompt.trim()) { if (!errors.length) r.errors.push('prompt absent ou vide'); continue; }
    if (values.description === undefined) r.warnings.push('description absente');
    else if (typeof values.description !== 'string') r.errors.push('description : chaîne attendue');
    else if (values.description.length > 100) r.warnings.push(`description de ${values.description.length} caractères : Gemini CLI la coupe à 100`);
    const prompt = values.prompt;
    for (const [, v] of prompt.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (v !== 'args') r.errors.push(`variable {{${v}}} inconnue : seule {{args}} existe`);
    if (/\{\{\s+args|args\s+\}\}/.test(prompt)) r.errors.push('{{args}} sans espaces');
    try {
      for (const cmd of extractInjections(prompt, '!{')) {
        if (!cmd) { r.errors.push('injection !{} vide'); continue; }
        for (const token of cmd.split(/\s+/)) if (ROOT_PATHS.test(token) && !existsSync(join(root, token))) r.errors.push(`!{${cmd}} : ${token} absent`);
        // Commande telle que Gemini CLI la soumet aux politiques : {{args}} vide, puis non vide
        const forms = [cmd.split('{{args}}').join(''), cmd.split('{{args}}').join('x')];
        if (!forms.every((c) => allowPrefixes.some((p) => prefixCovers(p, c)))) {
          r.errors.push(`!{${cmd}} : aucune politique du dépôt ne l'autorise (règle allow, commandPrefix, dans skills/*/assets/*.toml) ; en headless, la commande serait refusée`);
        }
      }
      for (const path of extractInjections(prompt, '@{')) {
        if (!path) r.errors.push('injection @{} vide');
        else if (ROOT_PATHS.test(path) && !existsSync(join(root, path))) r.errors.push(`@{${path}} : fichier absent`);
      }
    } catch (e) {
      r.errors.push(e.message);
    }
    checkCitations(r, prompt);
  }

  // Sous-agents
  const agentsDir = join(root, 'agents');
  for (const file of existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md') && !f.startsWith('_')) : []) {
    const stem = file.replace(/\.md$/, '');
    const r = result('sous-agent', stem, `agents/${file}`);
    const { data, body, errors } = parseFrontmatter(readFileSync(join(agentsDir, file), 'utf8'));
    for (const e of errors) r.errors.push(`frontmatter, ligne ${e.line} : ${e.message}`);
    if (!data) continue;
    const extra = Object.keys(data).filter((k) => !AGENT_KEYS.has(k));
    if (extra.length) r.errors.push(`clés refusées par Gemini CLI : ${extra.join(', ')}`);
    if (data.name !== stem) r.errors.push(`name « ${data.name} » différent du fichier « ${stem} »`);
    if (!PORTABLE_NAME.test(String(data.name ?? ''))) r.errors.push('name : minuscules, chiffres et tirets');
    if (typeof data.description !== 'string' || !data.description.trim()) r.errors.push('description absente');
    if (data.kind !== undefined && data.kind !== 'local') r.errors.push('kind : local seulement (agents distants non pris en charge ici)');
    if (data.tools !== undefined) {
      if (!Array.isArray(data.tools)) r.errors.push('tools : liste attendue');
      else for (const t of data.tools) if (!isKnownTool(String(t))) r.errors.push(`outil inconnu de Gemini CLI 0.65 : ${t}`);
    }
    for (const k of ['max_turns', 'timeout_mins']) {
      if (data[k] !== undefined && !(Number.isInteger(data[k]) && data[k] > 0)) r.errors.push(`${k} : entier positif attendu`);
    }
    if (data.temperature !== undefined && !(typeof data.temperature === 'number' && data.temperature >= 0 && data.temperature <= 2)) r.errors.push('temperature : nombre entre 0 et 2');
    if (data.mcp_servers !== undefined) r.warnings.push('mcp_servers : non contrôlé ici (vérifié par Gemini CLI, tools/check-extension.mjs)');
    if (!body.trim()) r.errors.push('corps vide : il porte les instructions du sous-agent');
    checkCitations(r, body);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const { values: opt } = parseArgs({ options: { racine: { type: 'string' }, json: { type: 'boolean', default: false } } });
  const root = resolve(opt.racine ?? fileURLToPath(new URL('..', import.meta.url)));
  const results = checkComponents(root);
  const failed = results.filter((r) => r.errors.length);
  const warned = results.filter((r) => r.warnings.length);
  if (opt.json) console.log(JSON.stringify(results, null, 2));
  else {
    const out = ['Composants du dépôt GeminiBoard', ''];
    for (const r of results) {
      out.push(`${r.errors.length ? 'KO   ' : r.warnings.length ? 'AVERT' : 'OK   '} ${r.type} ${r.name ?? ''} (${r.path})`);
      for (const e of r.errors) out.push(`        - ${e}`);
      for (const w of r.warnings) out.push(`        - (avertissement) ${w}`);
    }
    out.push('', `Bilan : ${results.length} éléments contrôlés, ${failed.length} en échec, ${warned.length} avec avertissement.`);
    console.log(out.join('\n'));
  }
  process.exit(failed.length ? 1 : 0);
}
