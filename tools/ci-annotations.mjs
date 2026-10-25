// ci-annotations.mjs : rapporteur de node --test pour GitHub Actions (Node.js 20 ou plus).
// Chaque test en échec devient une annotation (::error), et la fin donne un bilan (::notice) :
// les résultats se lisent dans la PR, ou par l'API des check runs, sans ouvrir les journaux.
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Échappement des commandes de workflow : message, puis propriétés (file, line, title)
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const where = `Node.js ${process.version}, ${process.platform}`;

function fileOf(file) {
  if (!file) return null;
  const path = file.startsWith('file:') ? fileURLToPath(file) : file;
  return relative(process.cwd(), path).replace(/\\/g, '/');
}

export default async function* annotations(source) {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for await (const { type, data } of source) {
    if ((type !== 'test:pass' && type !== 'test:fail') || data.nesting !== 0) continue;
    if (data.skip || data.todo) { skip++; continue; }
    if (type === 'test:pass') { pass++; continue; }
    fail++;
    const error = data.details?.error;
    const cause = error?.cause ?? error;
    const stack = String(cause?.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 3).join('\n');
    const message = [cause?.message ?? String(cause ?? 'échec'), stack].filter(Boolean).join('\n');
    const file = fileOf(data.file);
    const props = [file && `file=${prop(file)}`, data.line && `line=${data.line}`, `title=${prop(`${data.name} (${where})`)}`];
    yield `::error ${props.filter(Boolean).join(',')}::${esc(message)}\n`;
  }
  yield `::notice title=${prop(`Tests, ${where}`)}::${esc(`réussis : ${pass}, en échec : ${fail}, ignorés : ${skip}`)}\n`;
}
