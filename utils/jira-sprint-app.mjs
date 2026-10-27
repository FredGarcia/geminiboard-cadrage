#!/usr/bin/env node
// jira-sprint-app.mjs : interface locale qui exporte les tickets du prochain sprint par l'API REST de Jira,
// avec un identifiant et un mot de passe. Pour un Jira sans SSO dont l'API accepte l'authentification
// de base (Data Center) ; Jira Cloud exige un jeton d'API à la place du mot de passe ; derrière un SSO,
// utiliser plutôt jira-capture-app.mjs.
// Node.js 20, sans dépendance. Les identifiants ne servent qu'à la requête en cours : ni stockés, ni journalisés.
// Usage, depuis utils/ : npm run export, puis ouvrir http://127.0.0.1:3000 (autre port : variable PORT).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PAGE_FILE = fileURLToPath(new URL('./public/index.html', import.meta.url));
const DEFAULT_POINTS_FIELD = 'customfield_10016'; // varie selon l'instance
const BASE_FIELDS = ['summary', 'status', 'assignee', 'priority', 'issuetype',
                     'labels', 'parent', 'issuelinks', 'description'];
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Nom d'hôte d'un en-tête Host (« 127.0.0.1:3000 » donne « 127.0.0.1 »). */
const hostnameOf = (host) => String(host ?? '').match(/^([^:]+)(?::\d+)?$/)?.[1].toLowerCase() ?? null;

// Hôte, origine et type de contenu contrôlés, comme le serveur du board (README, §11) : une page web
// ouverte dans le navigateur ne peut pas piloter l'application, même par un nom de domaine qui
// pointerait vers 127.0.0.1.
function checkRequest(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) {
    throw new HttpError(403, "Hôte refusé : l'application ne répond qu'à 127.0.0.1 et localhost");
  }
  const origin = req.headers.origin;
  const port = req.socket.localPort;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    throw new HttpError(403, `Origine refusée : ${origin}`);
  }
  if (req.method === 'POST' && !/^application\/json\s*(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    throw new HttpError(415, 'Corps JSON attendu (Content-Type: application/json)');
  }
}

function authHeader(login, password) {
  return 'Basic ' + Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
}

async function jira(baseUrl, auth, path, params = {}) {
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', Authorization: auth } });
  } catch (err) {
    throw new HttpError(502, `Connexion impossible à ${url.origin} (${err.cause?.code ?? err.message})`);
  }
  if (res.status === 401) {
    throw new HttpError(401,
      "Authentification refusée. Sur Jira Cloud, l'API n'accepte pas le mot de passe : il faut un jeton d'API. " +
      "Sur Data Center, vérifiez l'identifiant et que l'authentification de base est activée.");
  }
  if (res.status === 403) throw new HttpError(403, `Accès refusé sur ${path}`);
  if (!res.ok) throw new HttpError(502, `Jira a répondu HTTP ${res.status} sur ${path}`);
  return res.json();
}

async function paginate(baseUrl, auth, path, params = {}, pageSize = 50) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const data = await jira(baseUrl, auth, path, { ...params, startAt, maxResults: pageSize });
    const items = data.issues ?? data.values ?? [];
    out.push(...items);
    startAt += items.length;
    if (!items.length || data.isLast === true) break;
    if (data.total !== undefined && startAt >= data.total) break;
  }
  return out;
}

async function findBoard(baseUrl, auth, nameOrId) {
  if (/^\d+$/.test(nameOrId)) return jira(baseUrl, auth, `/rest/agile/1.0/board/${nameOrId}`);
  const boards = await paginate(baseUrl, auth, '/rest/agile/1.0/board', { name: nameOrId });
  const exact = boards.filter((b) => b.name.toLowerCase() === nameOrId.toLowerCase());
  const candidates = exact.length ? exact : boards;
  if (!candidates.length) throw new HttpError(404, `Aucun tableau nommé « ${nameOrId} »`);
  if (candidates.length > 1) {
    const list = candidates.map((b) => `${b.id} : ${b.name}`).join(' ; ');
    throw new HttpError(400, `Plusieurs tableaux correspondent, indiquez l'identifiant (${list})`);
  }
  return candidates[0];
}

async function pickSprint(baseUrl, auth, boardId, wanted) {
  const sprints = await paginate(baseUrl, auth, `/rest/agile/1.0/board/${boardId}/sprint`, { state: 'future' });
  if (!sprints.length) throw new HttpError(404, 'Aucun sprint futur sur ce tableau');
  if (wanted) {
    const match = sprints.find((s) => s.name === wanted || String(s.id) === wanted);
    if (!match) throw new HttpError(404, `Sprint « ${wanted} » introuvable parmi les sprints futurs`);
    return match;
  }
  // Le prochain sprint est celui qui démarre le plus tôt
  return sprints.reduce((a, b) => ((b.startDate ?? '9999') < (a.startDate ?? '9999') ? b : a));
}

// Extrait le texte d'une description (texte brut ou format ADF de Jira Cloud)
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ');
  if (typeof node === 'object') {
    if (typeof node.text === 'string') return node.text;
    return (node.content ?? []).map(textOf).filter(Boolean).join(' ');
  }
  return '';
}

function toRow(issue, pointsField) {
  const f = issue.fields ?? {};
  return {
    cle: issue.key,
    type: f.issuetype?.name ?? '',
    resume: f.summary ?? '',
    statut: f.status?.name ?? '',
    assigne: f.assignee?.displayName ?? 'Non assigné',
    priorite: f.priority?.name ?? '',
    estimation: f[pointsField] ?? '',
    parent: f.parent?.key ?? '',
    libelles: (f.labels ?? []).join(';'),
    nb_liens: (f.issuelinks ?? []).length,
    description: textOf(f.description).split(/\s+/).filter(Boolean).join(' '),
  };
}

async function exportSprint({ url, login, password, board, sprint, pointsField }) {
  const auth = authHeader(login, password);
  const b = await findBoard(url, auth, board);
  const s = await pickSprint(url, auth, b.id, sprint);
  const issues = await paginate(url, auth, `/rest/agile/1.0/sprint/${s.id}/issue`,
    { fields: [...BASE_FIELDS, pointsField].join(',') });
  return {
    board: { id: b.id, name: b.name },
    sprint: { id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate },
    tickets: issues.map((i) => toRow(i, pointsField)),
  };
}

function parseInput(body) {
  const required = (key) => {
    const v = String(body[key] ?? '').trim();
    if (!v) throw new HttpError(400, `Champ manquant : ${key}`);
    return v;
  };
  let url;
  try {
    url = new URL(required('url'));
  } catch {
    throw new HttpError(400, 'URL Jira invalide');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new HttpError(400, 'URL Jira invalide');
  if (!body.password) throw new HttpError(400, 'Champ manquant : password');
  return {
    url: url.origin + url.pathname.replace(/\/+$/, ''),
    login: required('login'),
    password: String(body.password), // pas de trim : le mot de passe est pris tel quel
    board: required('board'),
    sprint: String(body.sprint ?? '').trim() || null,
    pointsField: String(body.pointsField ?? '').trim() || DEFAULT_POINTS_FIELD,
  };
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 100_000) throw new HttpError(413, 'Requête trop volumineuse');
  }
  try {
    return JSON.parse(data || '{}');
  } catch {
    throw new HttpError(400, 'Requête JSON invalide');
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  try {
    checkRequest(req);
    if (req.method === 'GET' && req.url === '/') {
      const html = await readFile(PAGE_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'POST' && req.url === '/api/export') {
      const input = parseInput(await readJson(req));
      return sendJson(res, 200, await exportSprint(input));
    }
    sendJson(res, 404, { error: 'Introuvable' });
  } catch (err) {
    // Le message d'erreur ne contient jamais le mot de passe
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Erreur interne';
    if (status === 500) console.error(err);
    sendJson(res, status, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Application prête : ouvrez http://${HOST}:${PORT} dans votre navigateur (Ctrl+C pour arrêter)`);
});
