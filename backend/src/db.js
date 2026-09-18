// db.js — thin wrapper around Node's built-in SQLite (node:sqlite, Node 22+).
// Chosen deliberately over better-sqlite3 to avoid native-module compilation
// on the developer/hosting side. Swap for a `pg` Pool with the same query
// shapes when migrating to PostgreSQL — see README "Migration path".

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'obit.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

export function migrate() {
  const schemaPath = path.join(__dirname, '..', 'migrations', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
  // Forward-compatible SQLite upgrades for existing persistent databases.
  const withdrawalCols = all('PRAGMA table_info(withdrawal_requests)').map((r) => r.name);
  if (!withdrawalCols.includes('bank_account_id')) db.exec('ALTER TABLE withdrawal_requests ADD COLUMN bank_account_id INTEGER REFERENCES member_bank_accounts(id)');
  if (!withdrawalCols.includes('transfer_reference')) db.exec('ALTER TABLE withdrawal_requests ADD COLUMN transfer_reference TEXT');
}

// Small helpers so route files read like plain SQL, not ORM boilerplate.
export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}
