// scenarios.mjs : scénarios du spike de capture (étape 1, points S1 à S4 du cadrage).
// Prompts synthétiques, exécutés dans un dossier de travail temporaire.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Contenu du dossier de travail synthétique
export const WORKSPACE_FILES = {
  'notes.md': '# Notes de test\n\nGeminiBoard capture les échanges de Gemini CLI.\nLe mot clé du projet est : SPIKE-ALPHA.\n',
  'src/calc.js': 'export function addition(a, b) {\n  return a + b;\n}\n',
};

export const assistantText = (events) => events
  .filter((e) => e.type === 'message' && e.role === 'assistant')
  .map((e) => e.content ?? '').join('');

// Appels d'outils avec le statut de leur résultat
export function toolCalls(events) {
  const status = new Map(events.filter((e) => e.type === 'tool_result').map((e) => [e.tool_id, e.status]));
  return events.filter((e) => e.type === 'tool_use')
    .map((e) => ({ name: e.tool_name, status: status.get(e.tool_id) ?? 'sans résultat' }));
}

const statusesOf = (events, name) => toolCalls(events).filter((t) => t.name === name).map((t) => t.status);
const verdict = (ok, label) => ({ ok, label });
const fileVerdict = (workspace, file, expected) => {
  const exists = existsSync(join(workspace, file));
  return verdict(exists === expected, exists ? `${file} créé` : `${file} absent`);
};
const shellVerdict = (events, expected) => {
  const s = statusesOf(events, 'run_shell_command');
  if (s.length === 0) return verdict(null, 'aucun appel shell tenté');
  return verdict(s.includes(expected), `run_shell_command : ${s.join(', ')}`);
};

/**
 * Chaque tour : id, session ('new' ou une clé partagée entre tours), approvalMode,
 * prompt (ou prompts : tours lancés en parallèle sur la même session), policies, check.
 */
export function buildScenarios({ withYolo = false, policyFile }) {
  const s3 = [
    { id: 'T1', session: 'new', approvalMode: 'default',
      prompt: 'Crée le fichier essai-default.txt contenant le mot bonjour.',
      check: ({ workspace }) => fileVerdict(workspace, 'essai-default.txt', false) },
    { id: 'T2', session: 'new', approvalMode: 'auto_edit',
      prompt: 'Crée le fichier essai-auto-edit.txt contenant le mot bonjour.',
      check: ({ workspace }) => fileVerdict(workspace, 'essai-auto-edit.txt', true) },
    { id: 'T3', session: 'new', approvalMode: 'auto_edit',
      prompt: 'Exécute la commande shell ls et indique le nombre de fichiers listés.',
      check: ({ events }) => shellVerdict(events, 'error') },
    { id: 'T4', session: 'new', approvalMode: 'auto_edit', policies: [policyFile],
      prompt: 'Exécute la commande shell ls et indique le nombre de fichiers listés.',
      check: ({ events }) => shellVerdict(events, 'success') },
    { id: 'T5', session: 'new', approvalMode: 'plan',
      prompt: 'Crée le fichier essai-plan.txt contenant le mot bonjour.',
      check: ({ workspace }) => fileVerdict(workspace, 'essai-plan.txt', false) },
  ];
  if (withYolo) {
    s3.push({ id: 'T6', session: 'new', approvalMode: 'yolo',
      prompt: 'Exécute la commande shell echo spike-yolo et recopie sa sortie.',
      check: ({ events }) => shellVerdict(events, 'success') });
  }

  return [
    {
      id: 'S1', title: 'Corpus : outils, fragments et erreurs',
      expectation: 'Événements init, message (fragments delta), tool_use, tool_result et result ; une erreur d\'outil au T3.',
      turns: [
        { id: 'T1', session: 'new', approvalMode: 'default',
          prompt: 'Lis le fichier notes.md et cite le mot clé du projet. Réponds en une phrase.',
          check: ({ events }) => verdict(assistantText(events).includes('SPIKE-ALPHA'), 'mot clé SPIKE-ALPHA cité') },
        { id: 'T2', session: 'new', approvalMode: 'default',
          prompt: 'Liste les fichiers du dossier courant, puis cherche le mot « addition » dans les sources. Réponds en deux phrases.',
          check: ({ events }) => verdict(toolCalls(events).length >= 2, `${toolCalls(events).length} appel(s) d'outils`) },
        { id: 'T3', session: 'new', approvalMode: 'default',
          prompt: 'Lis le fichier absent.md et dis-moi ce qu\'il contient.',
          check: ({ events }) => verdict(toolCalls(events).some((t) => t.status === 'error'), 'outil en erreur observé') },
      ],
    },
    {
      id: 'S2', title: 'Reprise de session',
      expectation: 'La session garde la mémoire entre tours ; comportement de deux tours simultanés sur la même session.',
      turns: [
        { id: 'T1', session: 'memo', approvalMode: 'default',
          prompt: 'Retiens ce mot fictif : ORNITHORYNQUE-42. Réponds uniquement : noté.',
          check: () => verdict(null, 'mot confié') },
        { id: 'T2', session: 'memo', approvalMode: 'default',
          prompt: 'Quel mot t\'ai-je demandé de retenir ? Réponds uniquement par ce mot.',
          check: ({ events }) => verdict(assistantText(events).includes('ORNITHORYNQUE-42'), 'mot restitué après reprise') },
        { id: 'T3', session: 'memo', approvalMode: 'default',
          prompts: ['Réponds uniquement par la lettre A.', 'Réponds uniquement par la lettre B.'],
          check: ({ result }) => verdict(null, `tour parallèle terminé avec le code ${result.code}`) },
        { id: 'T4', session: 'memo', approvalMode: 'default',
          prompt: 'Quelles lettres t\'ai-je demandé d\'écrire dans mes deux messages précédents ? Réponds en une ligne.',
          check: ({ events }) => verdict(null, `réponse : ${assistantText(events).trim().slice(0, 80) || '(vide)'}`) },
      ],
    },
    {
      id: 'S3', title: 'Modes d\'approbation et politiques',
      expectation: 'default et plan refusent l\'écriture ; auto_edit écrit mais refuse le shell ; la politique autorise ls.',
      turns: s3,
    },
    {
      id: 'S4', title: 'Délai de démarrage',
      expectation: 'Délai entre le lancement du processus, l\'événement init et le premier fragment de réponse.',
      turns: [1, 2, 3].map((i) => ({ id: `T${i}`, session: 'new', approvalMode: 'default',
        prompt: 'Réponds uniquement : OK.', check: () => verdict(null, 'mesure') })),
    },
  ];
}
