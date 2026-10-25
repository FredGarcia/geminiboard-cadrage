// ci-spike-check.mjs : contrôle une sortie du spike produite en CI avec le vrai Gemini CLI et une clé
// d'API invalide. Vérifie le lancement (code 144, result en erreur), la mesure de la mémoire et le
// masquage, puis publie un bilan en annotations GitHub Actions. Usage : node tools/ci-spike-check.mjs <dossier>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2];
const run = readdirSync(out).find((d) => d.startsWith('spike-'));
if (!run) { console.log(`::error::aucune sortie du spike dans ${out}`); process.exit(1); }
const dir = join(out, run);
const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
const env = JSON.parse(readFileSync(join(dir, 'environnement.json'), 'utf8'));
const metas = readdirSync(join(dir, 'S4')).filter((f) => f.endsWith('.meta.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, 'S4', f), 'utf8')));

const problems = [];
if (metas.length !== 3) problems.push(`${metas.length} tours au lieu de 3`);
for (const m of metas) {
  if (m.exit.code !== 144 || m.exit.result?.status !== 'error') {
    problems.push(`${m.turn} : code ${m.exit.code}, result ${m.exit.result?.status ?? 'absent'} (attendu : 144, error)`);
  }
  if (!(m.memoryPeakMb > 50)) problems.push(`${m.turn} : mémoire non mesurée (${m.memoryPeakMb})`);
}

// Masquage : ni dossier personnel ni nom d'utilisateur, sous aucune forme, ni dossier de travail temporaire
const text = files(dir).map((f) => readFileSync(f, 'utf8')).join('\n');
const home = homedir();
for (const form of new Set([home, JSON.stringify(home).slice(1, -1), home.replace(/\\/g, '/')])) {
  if (text.toLowerCase().includes(form.toLowerCase())) problems.push(`dossier personnel non masqué : ${form}`);
}
const user = userInfo().username;
if (new RegExp(`(?<![\\w.-])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text)) {
  problems.push(`nom d'utilisateur non masqué : ${user}`);
}
if (/geminiboard-spike-\w{6}/.test(text)) problems.push('dossier de travail temporaire non masqué');

const mem = metas.map((m) => m.memoryPeakMb).filter((v) => typeof v === 'number').sort((a, b) => a - b);
const title = `Gemini CLI ${env.gemini} réel, ${env.platform}, Node.js ${env.node}`;
for (const p of problems) console.log(`::error title=${title.replace(/,/g, '%2C')}::${p}`);
console.log(`::notice title=${title.replace(/,/g, '%2C')}::`
  + `codes : ${metas.map((m) => m.exit.code).join(', ')} ; mémoire par tour : ${mem.join(', ')} Mo (${env.launch.memoryScope}) ; `
  + `durées : ${metas.map((m) => (m.timings.total_ms / 1000).toFixed(1)).join(', ')} s ; ${problems.length ? `${problems.length} problème(s)` : 'masquage vérifié'}`);
process.exit(problems.length ? 1 : 0);
