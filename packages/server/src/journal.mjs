// journal.mjs : ouverture de la base SQLite et application des migrations.
// Node.js 20 ou plus ; better-sqlite3 12 (la 13 exige Node.js 22).
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/**
 * Ouvre la base. En écriture : pragmas du board et migrations en attente.
 * En lecture seule (serveur MCP, Claude) : query_only, aucune migration.
 */
export function openJournal(dbPath, { migrationsDir = MIGRATIONS_DIR, readonly = false } = {}) {
  if (readonly) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    return db;
  }
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db, migrationsDir);
  return db;
}

/**
 * Applique, dans l'ordre, les fichiers NNN_nom.sql pas encore appliqués, chacun dans une transaction.
 * Refuse de continuer si une migration déjà appliquée a changé depuis (empreinte sha256).
 */
export function migrate(db, migrationsDir = MIGRATIONS_DIR) {
  const files = readdirSync(migrationsDir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const known = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get();
  const applied = new Map(known
    ? db.prepare('SELECT version, checksum FROM schema_migration').all().map((r) => [r.version, r.checksum])
    : []);
  const done = [];
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(version)) {
      if (applied.get(version) !== checksum) {
        throw new Error(`migration ${file} modifiée après application : créer plutôt une nouvelle migration`);
      }
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (version, name, checksum) VALUES (?, ?, ?)')
        .run(version, file.replace(/\.sql$/, ''), checksum);
      db.pragma(`user_version = ${version}`);
    })();
    done.push(file);
  }
  return done;
}
