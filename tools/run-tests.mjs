// run-tests.mjs : lance la suite de tests (node --test, Node.js 20 ou plus) depuis la racine du dépôt.
// Les options reçues (rapporteurs, filtres) passent avant la liste des fichiers, comme l'exige node --test.
// Usage : npm test, ou npm run test:ci (avec les annotations pour GitHub Actions).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_FILES = [
  'packages/server/test/run-gemini.test.mjs',
  'packages/server/test/schema.test.mjs',
  'packages/server/test/projector.test.mjs',
  'packages/server/test/corpus.test.mjs',
  'spike/test/capture.test.mjs',
];

const root = fileURLToPath(new URL('..', import.meta.url));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...TEST_FILES], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
