#!/usr/bin/env node
// jira-capture-mhtml.mjs : la capture de jira-capture-app.mjs, en ligne de commande. Le navigateur s'ouvre sur la
// page du sprint ; on s'y connecte soi-même (SSO, MFA), puis Entrée dans le terminal lance la capture des tickets.
// Aucun identifiant ne passe par le script : la session SSO reste dans utils/.jira-profile/ (ignoré par git).
// Usage, depuis utils/ :
//   npm run capture:cli -- "<adresse de la page du sprint>" [--prefixe ABC] [--min 100] [--max 200]
//                          [--categorie "ticket avec ia" --categorie "ticket sans ia"] [--sortie <dossier>]
// Sortie : relative au dossier courant ; utils/mhtml/ par défaut (ignoré par git), dans un sous-dossier daté.
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  DEFAULT_CATEGORIES, DEFAULT_OUT_DIR, captureSprintTickets, launchBrowser, parseCategories, parseFilter,
} from './jira-capture-core.mjs';

const USAGE = 'Usage : node jira-capture-mhtml.mjs "<adresse de la page du sprint>" [--prefixe ABC] [--min N] [--max N] '
  + '[--categorie "<terme>"]… [--sortie <dossier>]';

let options;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      prefixe: { type: 'string' },
      min: { type: 'string' },
      max: { type: 'string' },
      categorie: { type: 'string', multiple: true },
      sortie: { type: 'string' },
    },
  });
  if (positionals.length < 1 || positionals.length > 2) throw new Error('une adresse de page attendue');
  options = {
    url: positionals[0],
    folder: values.sortie ?? positionals[1], // second argument : ancienne forme, toujours acceptée
    filter: parseFilter({ prefix: values.prefixe, min: values.min, max: values.max }),
    categories: parseCategories(values.categorie ?? DEFAULT_CATEGORIES),
  };
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}

const context = await launchBrowser();
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {
    console.log("La page n'a pas fini de charger : terminez la connexion dans la fenêtre.");
  });

  const rl = readline.createInterface({ input, output });
  await rl.question('Connectez-vous dans la fenêtre, attendez que les tickets soient affichés, puis appuyez sur Entrée… ');
  rl.close();

  const report = await captureSprintTickets(context, page, {
    folder: options.folder ? resolve(options.folder) : DEFAULT_OUT_DIR,
    filter: options.filter,
    categories: options.categories,
    onProgress: ({ step, done, total, key }) => {
      if (step === 'liste') console.log('Relevé des tickets sur la page du sprint…');
      if (step === 'tickets') console.log(`  [${done + 1}/${total}] ${key}`);
    },
  });

  console.log(`\nDossier : ${report.folder}`);
  console.log(`Tickets sur la page du sprint : ${report.listed} ; retenus par le filtre : ${report.selected} ; ignorés : ${report.ignored}`);
  for (const [name, n] of Object.entries(report.counts)) console.log(`  ${name} : ${n}`);
  console.log(`  erreurs : ${report.errors}`);
  for (const t of report.tickets) {
    if (t.error) console.log(`  ${t.key} : ${t.error}`);
    else if (!t.category) console.log(`  ${t.key} : à classer (${t.found.length ? `trouvé : ${t.found.join(' + ')}` : 'aucun terme clé'})`);
  }
  if (report.aborted) console.log('Capture arrêtée après plusieurs échecs de suite : vérifiez la session, puis relancez.');
  process.exitCode = report.errors ? 1 : 0;
} finally {
  await context.close();
}
