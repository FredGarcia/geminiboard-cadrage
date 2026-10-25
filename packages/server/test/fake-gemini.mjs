#!/usr/bin/env node
// Faux Gemini CLI pour les tests : imite --output-format stream-json (types de la v0.65).
// Comportements pilotés par le prompt ou l'environnement :
//   LONG                  attend l'arrêt (SIGINT, sortie 130)
//   FAIL42, FAIL55        sortie 42 ou 55
//   « Crée le fichier X »  écrit X si le mode d'approbation l'autorise (auto_edit, yolo)
//   « commande shell »     outil shell accepté en yolo ou avec --policy, refusé sinon
//   APIERR                erreur d'API : result en erreur, sortie 144 (statut HTTP 400 modulo 256)
//   FAKE_GEMINI_APIERR=1  même erreur d'API quel que soit le prompt
//   FAKE_GEMINI_EXIT=41   échec d'authentification avant tout événement
//   FAKE_GEMINI_HANG=1    attend l'arrêt quel que soit le prompt
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('0.0.0-faux\n');
  process.exit(0);
}
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const sessionId = get('--session-id') ?? get('--resume');
const mode = get('--approval-mode') ?? 'default';
const hasPolicy = args.includes('--policy');
const prompt = readFileSync(0, 'utf8'); // stdin complet
const ts = () => new Date().toISOString();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (process.env.FAKE_GEMINI_EXIT === '41') {
  process.stderr.write('Please set an Auth method before running.\n');
  process.exit(41);
}

process.stderr.write(`fake args=${JSON.stringify(args)}\n`);
out({ type: 'init', timestamp: ts(), session_id: sessionId, model: 'fake-model' });
out({ type: 'message', timestamp: ts(), role: 'user', content: prompt });

if (prompt.includes('APIERR') || process.env.FAKE_GEMINI_APIERR === '1') {
  out({ type: 'result', timestamp: ts(), status: 'error', error: { type: 'unknown', message: '[API Error: 400 Bad Request]' } });
  process.exit(144);
} else if (prompt.includes('LONG') || process.env.FAKE_GEMINI_HANG === '1') {
  process.on('SIGINT', () => process.exit(130));
  setTimeout(() => {}, 60000);
} else {
  // Une ligne JSON coupée en deux écritures, pour éprouver le découpage par lignes
  const line = JSON.stringify({ type: 'message', timestamp: ts(), role: 'assistant', content: 'Bonjour, ', delta: true }) + '\n';
  process.stdout.write(line.slice(0, 20));
  setTimeout(() => {
    process.stdout.write(line.slice(20));
    out({ type: 'tool_use', timestamp: ts(), tool_name: 'read_file', tool_id: 't1', parameters: { file_path: join(process.cwd(), 'notes.md') } });
    out({ type: 'tool_result', timestamp: ts(), tool_id: 't1', status: 'success', output: '# titre' });

    const create = prompt.match(/Crée le fichier (\S+)/);
    if (create) {
      const allowed = mode === 'auto_edit' || mode === 'yolo';
      const file = join(process.cwd(), create[1]);
      if (allowed) writeFileSync(file, 'bonjour\n');
      out({ type: 'tool_use', timestamp: ts(), tool_name: 'write_file', tool_id: 't2', parameters: { file_path: file, content: 'bonjour' } });
      out(allowed
        ? { type: 'tool_result', timestamp: ts(), tool_id: 't2', status: 'success', output: 'ok' }
        : { type: 'tool_result', timestamp: ts(), tool_id: 't2', status: 'error', error: { type: 'policy', message: 'Tool execution denied by policy.' } });
    }
    if (prompt.includes('commande shell')) {
      const allowed = mode === 'yolo' || hasPolicy;
      out({ type: 'tool_use', timestamp: ts(), tool_name: 'run_shell_command', tool_id: 't3', parameters: { command: 'ls' } });
      out(allowed
        ? { type: 'tool_result', timestamp: ts(), tool_id: 't3', status: 'success', output: 'notes.md\nsrc' }
        : { type: 'tool_result', timestamp: ts(), tool_id: 't3', status: 'error', error: { type: 'policy', message: 'Tool execution denied by policy.' } });
    }

    out({ type: 'message', timestamp: ts(), role: 'assistant', content: 'voilà.', delta: true });
    process.stdout.write('ligne non JSON\n');
    out({ type: 'result', timestamp: ts(), status: 'success',
      stats: { total_tokens: 30, input_tokens: 20, output_tokens: 10, cached: 0, input: 20, duration_ms: 5, tool_calls: 1, models: {} } });
    process.exit(prompt.includes('FAIL42') ? 42 : prompt.includes('FAIL55') ? 55 : 0);
  }, 30);
}
