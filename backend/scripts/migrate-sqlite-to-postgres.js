import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const candidates = [
  process.env.SQLITE_PATH,
  process.env.DB_PATH,
  '/var/data/obit.db',
  '/var/data/obit.sqlite',
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'obit.db')
].filter(Boolean);
const sqlitePath = candidates.find((p) => fs.existsSync(p));
if (!sqlitePath) throw new Error(`SQLite source not found. Checked: ${candidates.join(', ')}`);
console.log(`Using SQLite source: ${sqlitePath}`);

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, '..', 'migrations', 'postgres.sql'), 'utf8');
const source = new DatabaseSync(sqlitePath);
const target = new Client({ connectionString: url, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
await target.connect();

const tables = ['users','member_applications','members','ledger_accounts','transactions','ledger_entries','member_bank_accounts','withdrawal_requests'];
const cols = (table) => source.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);

try {
  await target.query('BEGIN');
  await target.query(schema);
  for (const table of tables) {
    const sourceCols = cols(table);
    const targetCols = (await target.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows.map(r=>r.column_name);
    const common = targetCols.filter(c => sourceCols.includes(c));
    const rows = source.prepare(`SELECT ${common.map(c=>'"'+c+'"').join(',')} FROM ${table} ORDER BY id`).all();
    for (const row of rows) {
      const vals = common.map(c => row[c]);
      const qs = vals.map((_,i)=>'$'+(i+1)).join(',');
      await target.query(`INSERT INTO ${table} (${common.map(c=>'"'+c+'"').join(',')}) VALUES (${qs}) ON CONFLICT DO NOTHING`, vals);
    }
  }
  for (const table of tables) {
    const s = Number(source.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
    const p = Number((await target.query(`SELECT COUNT(*) n FROM ${table}`)).rows[0].n);
    // PostgreSQL may already contain rows from an earlier guarded attempt.
    // Compare primary-key sets rather than raw counts, and fail on either
    // missing SQLite rows or unexpected target rows.
    const sourceIds = source.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(r => Number(r.id));
    const targetIds = (await target.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(r => Number(r.id));
    const sameIds = sourceIds.length === targetIds.length && sourceIds.every((id, i) => id === targetIds[i]);
    if (!sameIds) throw new Error(`Parity failed for ${table}: sqlite=${s}, postgres=${p}`);
  }
  const sqliteBalance = Number(source.prepare("SELECT COALESCE(SUM(balance_kobo),0) n FROM ledger_accounts").get().n);
  const pgBalance = Number((await target.query("SELECT COALESCE(SUM(balance_kobo),0) n FROM ledger_accounts")).rows[0].n);
  const sqliteLedger = Number(source.prepare("SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_kobo ELSE -amount_kobo END),0) n FROM ledger_entries").get().n);
  const pgLedger = Number((await target.query("SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_kobo ELSE -amount_kobo END),0) n FROM ledger_entries")).rows[0].n);
  if (sqliteBalance !== pgBalance || sqliteLedger !== pgLedger || pgBalance !== pgLedger) throw new Error('Financial parity failed');
  await target.query('COMMIT');
  console.log(JSON.stringify({ok:true, sqlite_balance_kobo:sqliteBalance, postgres_balance_kobo:pgBalance, ledger_kobo:pgLedger}));
} catch (e) {
  await target.query('ROLLBACK');
  throw e;
} finally {
  await target.end();
  source.close();
}
