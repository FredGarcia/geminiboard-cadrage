// redact.mjs : masquage avant écriture dans fixtures/, qui est publié dans un dépôt public.
// Clés d'API, adresses électroniques, chemins locaux et nom d'utilisateur.
// Sous Windows, un même chemin s'écrit de plusieurs façons : barres inverses ou obliques,
// forme échappée dans du JSON, nom court (JEANDU~1), lettre de lecteur en minuscule.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const jsonEscaped = (s) => JSON.stringify(s).slice(1, -1);

// Tout dossier personnel Windows, quelle que soit son écriture : C:\Users\nom, c:/users/nom, C:\\Users\\nom
const WINDOWS_HOME = /[A-Za-z]:(?:\\|\/)+Users(?:\\|\/)+[^\\/\s"'<>|:*?]+/gi;

/**
 * @param {Array<[string, string]>} entries  chemins à masquer et leur masque, par exemple [dossier, '<WORKSPACE>']
 * @param {object}  [o]
 * @param {boolean} [o.windows]   comparaison insensible à la casse et variantes de séparateurs
 * @param {string}  [o.username]  nom d'utilisateur, masqué comme mot entier (3 caractères au moins)
 * @returns {(s: unknown) => string}
 */
export function createRedactor(entries, { windows = process.platform === 'win32', username } = {}) {
  const pairs = [];
  for (const [value, mask] of entries) {
    if (!value || value.length < 2) continue;
    const forms = new Set([value]);
    if (windows) {
      forms.add(value.replace(/\\/g, '/'));
      forms.add(value.replace(/\//g, '\\'));
    }
    // Forme échappée dans du JSON, et doublement échappée (JSON contenu dans une chaîne JSON)
    for (const f of [...forms]) forms.add(jsonEscaped(f)).add(jsonEscaped(jsonEscaped(f)));
    for (const f of forms) pairs.push([f, mask]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length); // le chemin le plus long d'abord
  const flags = windows ? 'gi' : 'g';
  const paths = pairs.map(([value, mask]) => [new RegExp(escapeRe(value), flags), mask]);
  const user = username && username.length >= 3
    ? new RegExp(`(?<![\\w.-])${escapeRe(username)}(?![\\w-])`, flags) : null;

  return (s) => {
    let out = String(s ?? '')
      .replace(/AIza[0-9A-Za-z_-]{35}/g, '<API_KEY>')
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<EMAIL>');
    for (const [re, mask] of paths) out = out.replace(re, mask);
    out = out.replace(WINDOWS_HOME, '<HOME>');
    return user ? out.replace(user, '<USER>') : out;
  };
}
