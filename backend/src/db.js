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
  const userCols = all('PRAGMA table_info(users)').map((r) => r.name);
  if (!userCols.includes('session_version')) db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
  const withdrawalCols = all('PRAGMA table_info(withdrawal_requests)').map((r) => r.name);
  if (!withdrawalCols.includes('bank_account_id')) db.exec('ALTER TABLE withdrawal_requests ADD COLUMN bank_account_id INTEGER REFERENCES member_bank_accounts(id)');
  if (!withdrawalCols.includes('transfer_reference')) db.exec('ALTER TABLE withdrawal_requests ADD COLUMN transfer_reference TEXT');
  if (!withdrawalCols.includes('provider_status')) db.exec("ALTER TABLE withdrawal_requests ADD COLUMN provider_status TEXT DEFAULT 'not_started'");
  const kycCols = all('PRAGMA table_info(kyc_checks)').map((r) => r.name);
  if (!kycCols.includes('attempt_count')) db.exec('ALTER TABLE kyc_checks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
  if (!kycCols.includes('last_attempt_at')) db.exec('ALTER TABLE kyc_checks ADD COLUMN last_attempt_at TEXT');
  // Money v2: canonical integer-kobo mirrors. Existing naira columns remain
  // temporarily for backwards compatibility while routes migrate safely.
  const moneyTables = [
    ['transactions', 'amount'],
    ['ledger_accounts', 'balance'],
    ['ledger_entries', 'amount'],
    ['withdrawal_requests', 'amount'],
    ['membership_payments', 'amount'],
    ['contribution_plans', 'amount'],
    ['contribution_plans', 'target_amount'],
  ];
  for (const [table, source] of moneyTables) {
    const cols = all(`PRAGMA table_info(${table})`).map((r) => r.name);
    const target = source + '_kobo';
    if (!cols.includes(target)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${target} INTEGER`);
    // ROUND is intentional only for the one-time conversion of legacy REAL
    // naira values. New writes must supply integer kobo directly.
    db.exec(`UPDATE ${table} SET ${target} = CAST(ROUND(${source} * 100) AS INTEGER)
             WHERE ${source} IS NOT NULL AND ${target} IS NULL`);
  }

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

// Execute multi-step financial mutations atomically. Nested callers should
// keep transactions short and never perform network I/O inside this block.
export function atomic(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}
