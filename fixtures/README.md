# Fixtures

Corpus d'événements réels de Gemini CLI, collectés par le spike (`spike/capture.mjs`). Ils servent aux tests du projecteur : rejouer un dossier doit redonner les mêmes tables (objectif O2 du cadrage).

## Format

Un dossier par exécution du spike : `spike-<date>/`.

| Fichier | Contenu |
|---|---|
| `S<n>/T<n>.jsonl` | un événement `stream-json` par ligne, dans l'ordre de réception ; une ligne non JSON devient `{"type":"raw","line":"…"}` |
| `S<n>/T<n>.meta.json` | prompt, mode d'approbation, politiques, session (clé, identifiant, reprise), arguments sans le prompt, code de sortie, `result` final, délais, nombre d'événements par type, outils et statuts, texte de la réponse, fin de stderr, contrôle |
| `rapport.md` | tableaux par scénario, délais mesurés, synthèse |
| `environnement.json` | date, versions de Gemini CLI et de Node.js, plateforme, options |

Deux tours lancés en parallèle sur la même session portent les suffixes `a` et `b` (`S2/T3a`, `S2/T3b`).

## Règles

- Seulement des sessions synthétiques, produites par le spike : jamais d'extrait d'une session de travail. Ce dépôt est public.
- Chemins locaux masqués (`<WORKSPACE>`, `<HOME>`), ainsi que tout ce qui ressemble à une clé d'API ou à une adresse électronique.
- Relecture humaine avant tout commit.
