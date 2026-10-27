// capture.mjs : politique de capture d'un projet (README, §11), appliquée avant l'écriture dans le journal.
//   full      tout est journalisé, secrets masqués
//   metadata  le journal garde la forme des échanges (types, horodatages, outils, statuts, durées, jetons),
//             sans texte : ni prompt, ni réponse, ni paramètre d'outil, ni sortie, ni message d'erreur
//   off       rien n'est journalisé ; la discussion ne vit que le temps du serveur
// L'interface reçoit le flux complet (secrets masqués) quelle que soit la politique : seul l'écrit change.

export const CAPTURE_POLICIES = ['full', 'metadata', 'off'];

const errorType = (error) => (error && typeof error === 'object' && error.type ? { type: String(error.type) } : undefined);

/** Événement stream-json réduit à sa forme, pour la politique metadata. */
export function metadataOnly(event) {
  const e = event ?? {};
  const base = { type: e.type, timestamp: e.timestamp, capture: 'metadata' };
  switch (e.type) {
    case 'init':
      return { ...base, session_id: e.session_id, model: e.model };
    case 'message':
      return { ...base, role: e.role, delta: e.delta, content: '', length: String(e.content ?? '').length };
    case 'tool_use':
      return { ...base, tool_name: e.tool_name, tool_id: e.tool_id, parameters: {},
        parameter_keys: Object.keys(e.parameters ?? {}) };
    case 'tool_result':
      return { ...base, tool_id: e.tool_id, status: e.status, error: errorType(e.error) };
    case 'error':
      return { ...base, severity: e.severity };
    case 'result':
      return { ...base, status: e.status, error: errorType(e.error), stats: e.stats };
    default:
      return base; // raw et types inconnus : le type seul
  }
}

/** Charge de l'événement sortant « prompt », selon la politique. */
export function promptPayload(policy, { text, approvalMode, resume }) {
  return policy === 'metadata'
    ? { text: '', length: text.length, approvalMode, resume, capture: 'metadata' }
    : { text, approvalMode, resume };
}
