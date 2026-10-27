// Client en ligne de commande (src/geminiboard.mjs) contre un serveur du board et le faux Gemini CLI.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '@geminiboard/server';
import { main } from '../src/geminiboard.mjs';

const CLI = fileURLToPath(new URL('../src/geminiboard.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('../../server/test/fake-gemini.mjs', import.meta.url));
const clean = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
// Sessions tenues comme Gemini CLI 0.65 par le faux Gemini CLI (voir son en-tête)
process.env.FAKE_GEMINI_STATE = mkdtempSync(join(tmpdir(), 'geminiboard-sessions-'));
after(() => clean(process.env.FAKE_GEMINI_STATE));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'geminiboard-cli-'));
  const projectDir = join(dir, 'mon projet');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'notes.md'), '# titre\n');
  const app = await buildServer({ dbPath: join(dir, 'geminiboard.db'), entry: FAKE });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  /** Lance la commande dans ce processus ; rend { code, out, err }. */
  const run = async (argv, { cwd = dir, stdin = null, onInterrupt } = {}) => {
    let out = '';
    let err = '';
    const io = {
      out: (s) => { out += s; }, err: (s) => { err += s; }, env: { GEMINIBOARD_URL: url }, cwd,
      stdinIsTTY: stdin === null, readStdin: async () => stdin ?? '', onInterrupt, offInterrupt: () => {},
    };
    const code = await main(argv, io);
    return { code, out, err };
  };
  return { dir, projectDir, app, url, run, close: async () => { await app.close(); clean(dir); } };
}

test('usage : aide, commande ou option inconnue, serveur injoignable', async () => {
  const io = () => {
    const r = { out: '', err: '' };
    return [r, { out: (s) => { r.out += s; }, err: (s) => { r.err += s; }, env: { GEMINIBOARD_URL: 'http://127.0.0.1:9' }, cwd: tmpdir() }];
  };
  let [r, x] = io();
  assert.equal(await main([], x), 2);
  assert.match(r.out, /Usage : geminiboard <commande>/);
  [r, x] = io();
  assert.equal(await main(['aide'], x), 0);
  [r, x] = io();
  assert.equal(await main(['inconnue'], x), 2);
  assert.match(r.err, /commande inconnue : inconnue/);
  [r, x] = io();
  assert.equal(await main(['projets', '--option-inconnue'], x), 2);
  [r, x] = io();
  assert.equal(await main(['serveur', '--port', 'x'], x), 2);
  [r, x] = io();
  assert.equal(await main(['projets'], x), 3);
  assert.match(r.err, /serveur injoignable \(http:\/\/127\.0\.0\.1:9\)/);
});

test('projets : ajout (chemin relatif au dossier courant), approbation, retrait ; refus d\'un dossier non approuvé', async () => {
  const s = await setup();
  try {
    let r = await s.run(['projet', 'ajouter', 'mon projet', '--capture', 'metadata']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Projet « mon projet » ajouté \(mon-projet\)/);
    assert.match(r.out, /Capture : metadata\. Dossier non approuvé/);
    r = await s.run(['projets']);
    assert.match(r.out, /^mon-projet\s+non approuvé\s+capture metadata/m);
    r = await s.run(['discuter', '--projet', 'mon-projet', 'Bonjour']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[refusé\] dossier du projet « mon projet » non approuvé/);
    r = await s.run(['projet', 'approuver', 'mon-projet']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Gemini CLI y tournera avec --skip-trust/);
    assert.match((await s.run(['projets'])).out, /^mon-projet\s+approuvé /m);
    r = await s.run(['projet', 'retirer', 'mon-projet']);
    assert.match(r.out, /Approbation retirée/);
    assert.equal((await s.run(['projet', 'approuver', 'absent'])).code, 2);
    assert.equal((await s.run(['projet', 'ajouter', 'mon projet'])).code, 1, 'dossier déjà enregistré');
    assert.equal((await s.run(['projet', 'deplacer'])).code, 2);
  } finally { await s.close(); }
});

test('discuter : projet du dossier courant, réponse au fil de l\'eau, reprise, discussions, fil, santé', async () => {
  const s = await setup();
  try {
    await s.run(['projet', 'ajouter', s.projectDir, '--nom', 'Essai']);
    await s.run(['projet', 'approuver', 'essai']);
    let r = await s.run(['discuter', 'Résume', 'notes.md'], { cwd: join(s.projectDir, 'src') });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'Bonjour, voilà.\n');
    assert.match(r.err, /^\[discussion [0-9a-f-]{36}\]$/m);
    assert.match(r.err, /^\[outil\] read_file .*notes\.md$/m);
    assert.match(r.err, /^\[ok\]$/m);
    assert.match(r.err, /^\[fin\] terminé · 30 jetons/m);
    const id = r.err.match(/\[discussion ([0-9a-f-]{36})\]/)[1];

    r = await s.run(['discuter', '--discussion', id, '--mode', 'plan', 'Et ensuite ?']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, new RegExp(`\\[discussion ${id} · reprise\\]`));

    r = await s.run(['discuter', '--projet', 'essai', '--mode', 'n-importe', 'x']);
    assert.equal(r.code, 2);
    assert.match(r.err, /mode d'approbation inconnu/);
    assert.equal((await s.run(['discuter', 'sans projet'], { cwd: s.dir })).code, 2);
    assert.equal((await s.run(['discuter'], { stdin: null })).code, 2, 'ni texte ni entrée standard');
    r = await s.run(['discuter', '--projet', 'essai'], { stdin: 'Texte lu sur l\'entrée standard' });
    assert.equal(r.code, 0, r.err);

    r = await s.run(['discussions', '--projet', 'essai']);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`${id}\\s+2 tours\\s+Résume notes\\.md`));
    r = await s.run(['fil', id]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^# Résume notes\.md$/m);
    assert.match(r.out, /^## Tour 2 · terminé · 30 jetons$/m);
    assert.match(r.out, /^\*\*Vous\*\*\n\nEt ensuite \?$/m);
    assert.match(r.out, /^- `read_file` · terminé$/m);
    assert.equal((await s.run(['fil', '01a17300-0000-7000-8000-000000000000'])).code, 1);

    r = await s.run(['sante']);
    assert.match(r.out, /Tours en cours : 0 sur 1/);
    assert.match(r.out, /Base : schéma 1 · \d+ événements · 1 projets · 2 discussions/);
  } finally { await s.close(); }
});

test('discuter : Ctrl+C demande l\'arrêt du tour, qui est journalisé ; processus réel, prompt sur stdin', async () => {
  const s = await setup();
  try {
    await s.run(['projet', 'ajouter', s.projectDir, '--nom', 'Essai']);
    await s.run(['projet', 'approuver', 'essai']);
    let interrupt = null;
    const pending = s.run(['discuter', '--projet', 'essai', 'LONG travail'], { onInterrupt: (f) => { interrupt = f; } });
    const turn = s.app.turns;
    for (let i = 0; i < 400 && !turn.running().length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(turn.running().length, 1);
    interrupt();
    const r = await pending;
    assert.equal(r.code, 1);
    assert.match(r.err, /\[arrêt demandé/);
    assert.match(r.err, /\[fin\] annulé/);

    // Vrai processus : texte sur l'entrée standard, code de sortie, rien sur stdout que la réponse
    const child = spawn(process.execPath, [CLI, 'discuter', '--projet', 'essai'], {
      env: { ...process.env, GEMINIBOARD_URL: s.url }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end('Bonjour depuis un tube');
    const code = await new Promise((ok) => child.on('close', ok));
    assert.equal(code, 0, err);
    assert.equal(out, 'Bonjour, voilà.\n');
  } finally { await s.close(); }
});
