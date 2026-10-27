// redact.mjs : masquage des secrets avant écriture dans le journal (README, §11).
// Les motifs intégrés visent des secrets à forme reconnaissable : clés d'API, jetons, clés privées,
// en-têtes d'autorisation ; la configuration en ajoute d'autres (redactionPatterns).
// Le masquage s'applique à toutes les chaînes d'une valeur JSON, à toute profondeur.

const mask = (kind) => `«secret masqué : ${kind}»`;

// [nature, motif, remplacement] ; le remplacement garde ce qui n'est pas secret (le nom de l'en-tête)
const BUILTIN = [
  ['clé privée', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['clé Google', /AIza[0-9A-Za-z_-]{35}/g],
  ['jeton GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['clé Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['clé OpenAI', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['clé AWS', /\bAKIA[0-9A-Z]{16}\b/g],
  ['jeton Slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['jeton JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['autorisation', /\b(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    (_, head) => `${head}${mask('autorisation')}`],
];

/**
 * Crée la fonction de masquage. `extraPatterns` : sources d'expressions régulières (config.json).
 * Rend (valeur) => { value, count } : la valeur masquée (copie) et le nombre de remplacements.
 */
export function createRedactor(extraPatterns = []) {
  const rules = [...BUILTIN];
  for (const source of extraPatterns) {
    let re;
    try { re = new RegExp(String(source), 'g'); } catch (e) {
      throw new Error(`motif de masquage invalide « ${source} » : ${e.message}`);
    }
    if (re.test('')) throw new Error(`motif de masquage « ${source} » : il reconnaît la chaîne vide`);
    rules.push(['motif configuré', re]);
  }

  function redactString(s) {
    let count = 0;
    let out = s;
    for (const [kind, re, replace] of rules) {
      re.lastIndex = 0;
      out = out.replace(re, (...m) => {
        count++;
        return replace ? replace(...m) : mask(kind);
      });
    }
    return { value: out, count };
  }

  function walk(v) {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) {
      let count = 0;
      const value = v.map((x) => { const r = walk(x); count += r.count; return r.value; });
      return { value, count };
    }
    if (v && typeof v === 'object') {
      let count = 0;
      const value = {};
      for (const [k, x] of Object.entries(v)) { const r = walk(x); count += r.count; value[k] = r.value; }
      return { value, count };
    }
    return { value: v, count: 0 };
  }

  return walk;
}
