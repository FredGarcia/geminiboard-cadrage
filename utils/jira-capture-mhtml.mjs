#!/usr/bin/env node
// jira-capture-mhtml.mjs : la capture de jira-capture-app.mjs, en ligne de commande. Le navigateur s'ouvre
// sur la page ; on s'y connecte soi-même (SSO, MFA), puis Entrée dans le terminal lance la capture.
// Aucun identifiant ne passe par le script : la session SSO reste dans utils/.jira-profile/ (ignoré par git).
// Usage, depuis utils/ :
//   npm run capture:cli -- "<adresse de la page du sprint>" [dossier de sortie]
// Dossier de sortie : relatif au dossier courant ; utils/mhtml/ par défaut (ignoré par git).
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { DEFAULT_OUT_DIR, captureMhtml, launchBrowser, loadAllTickets, writeCapture } from './jira-capture-core.mjs';

const [, , url, outArg] = process.argv;
if (!url) {
  console.error('Usage : node jira-capture-mhtml.mjs "<adresse de la page du sprint>" [dossier de sortie]');
  process.exit(1);
}

const context = await launchBrowser();
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {
    console.log("La page n'a pas fini de charger : terminez la connexion dans la fenêtre.");
  });

  const rl = readline.createInterface({ input, output });
  await rl.question('Connectez-vous dans la fenêtre, attendez que le tableau soit affiché, puis appuyez sur Entrée… ');
  rl.close();

  const { seen, present } = await loadAllTickets(page);
  const file = await writeCapture(outArg ? resolve(outArg) : DEFAULT_OUT_DIR, await captureMhtml(context, page));
  console.log(`Enregistré : ${file}`);
  console.log(`Tickets repérés pendant le défilement : ${seen} ; présents dans la capture : ${present}`);
  if (present < seen) {
    console.log("La page retire les cartes sorties de l'écran : réduisez le zoom du navigateur (Ctrl -), puis recommencez.");
  }
} finally {
  await context.close();
}
