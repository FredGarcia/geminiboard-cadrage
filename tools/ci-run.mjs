// ci-run.mjs : lance une commande en CI et, si elle échoue, publie la fin de sa sortie en annotation
// GitHub Actions : l'échec se lit dans la PR, ou par l'API des check runs, sans ouvrir les journaux.
// Usage : node tools/ci-run.mjs "<titre>" <commande> [arguments...]
import { spawn } from 'node:child_process';

const [title, ...command] = process.argv.slice(2);
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const child = spawn(command.join(' '), { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
let tail = '';
const keep = (chunk) => { process.stdout.write(chunk); tail = (tail + chunk).slice(-8000); };
child.stdout.on('data', keep);
child.stderr.on('data', keep);
child.on('close', (code, signal) => {
  if (code !== 0) {
    const lines = tail.split(/\r?\n/).filter((l) => l.trim()).slice(-40).join('\n');
    const head = `code ${code ?? signal}`;
    process.stdout.write(`\n::error title=${esc(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}::${esc(`${head}\n${lines}`)}\n`);
  }
  process.exit(code ?? 1);
});
