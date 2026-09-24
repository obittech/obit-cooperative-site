// Database adapter: SQLite rollback path + PostgreSQL production path.
// DB_ENGINE=sqlite (default) preserves the existing persistent-disk runtime.
// DB_ENGINE=postgres uses DATABASE_URL and the same get/all/run/atomic interface.

import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'obit.db');
export const DB_ENGINE = String(process.env.DB_ENGINE || 'sqlite').toLowerCase();
if (!['sqlite','postgres'].includes(DB_ENGINE)) throw new Error('DB_ENGINE must be sqlite or postgres');

let sqlite = null;
let pool = null;
const txContext = new AsyncLocalStorage();

if (DB_ENGINE === 'sqlite') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  sqlite = new DatabaseSync(DB_PATH);
} else {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when DB_ENGINE=postgres');
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

function sqliteMigrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'schema.sql'), 'utf8');
  sqlite.exec(schema);
  const cols = (table) => sqlite.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name);
  const userCols = cols('users');
  if (!userCols.includes('session_version')) sqlite.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
  const withdrawalCols = cols('withdrawal_requests');
  if (!withdrawalCols.includes('bank_account_id')) sqlite.exec('ALTER TABLE withdrawal_requests ADD COLUMN bank_account_id INTEGER REFERENCES member_bank_accounts(id)');
  if (!withdrawalCols.includes('transfer_reference')) sqlite.exec('ALTER TABLE withdrawal_requests ADD COLUMN transfer_reference TEXT');
  if (!withdrawalCols.includes('provider_status')) sqlite.exec("ALTER TABLE withdrawal_requests ADD COLUMN provider_status TEXT DEFAULT 'not_started'");
  const kycCols = cols('kyc_checks');
  if (!kycCols.includes('attempt_count')) sqlite.exec('ALTER TABLE kyc_checks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
  if (!kycCols.includes('last_attempt_at')) sqlite.exec('ALTER TABLE kyc_checks ADD COLUMN last_attempt_at TEXT');
  const moneyTables=[['transactions','amount'],['ledger_accounts','balance'],['ledger_entries','amount'],['withdrawal_requests','amount'],['membership_payments','amount'],['contribution_plans','amount'],['contribution_plans','target_amount']];
  for(const [table,source] of moneyTables){
    const tableCols=cols(table); const target=source+'_kobo';
    if(!tableCols.includes(target)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${target} INTEGER`);
    sqlite.exec(`UPDATE ${table} SET ${target}=CAST(ROUND(${source}*100) AS INTEGER) WHERE ${source} IS NOT NULL AND ${target} IS NULL`);
  }
}

export async function migrate() {
  if (DB_ENGINE === 'sqlite') { sqliteMigrate(); return; }
  const schema = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'postgres.sql'), 'utf8');
  await pool.query(schema);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0");
}

function translateSql(input) {
  let sql=String(input);
  sql=sql.replace(/datetime\('now'\s*,\s*'-([0-9]+)\s+(minute|minutes|hour|hours|day|days)'\)/gi, (_m,n,u)=>`(CURRENT_TIMESTAMP - INTERVAL '${n} ${u}')`);
  sql=sql.replace(/datetime\('now'\)/gi,'CURRENT_TIMESTAMP');
  const ignore=/^\s*INSERT\s+OR\s+IGNORE\s+/i.test(sql);
  if(ignore) sql=sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+/i,'INSERT ');
  let out='', idx=0, quote=null;
  for(let i=0;i<sql.length;i++){
    const ch=sql[i];
    if(quote){
      out+=ch;
      if(ch===quote && sql[i-1]!=='\\') quote=null;
      continue;
    }
    if(ch==="'"||ch==='"'){quote=ch;out+=ch;continue;}
    if(ch==='?'){idx++;out+='$'+idx;continue;}
    out+=ch;
  }
  if(ignore) out=out.replace(/;?\s*$/,' ON CONFLICT DO NOTHING');
  return out;
}
function pgExecutor(){ return txContext.getStore() || pool; }

export async function run(sql, params=[]) {
  if(DB_ENGINE==='sqlite') return sqlite.prepare(sql).run(...params);
  let q=translateSql(sql);
  const isInsert=/^\s*INSERT\s+/i.test(q);
  if(isInsert && !/\bRETURNING\b/i.test(q)) q += ' RETURNING id';
  const result=await pgExecutor().query(q,params);
  return { lastInsertRowid: result.rows?.[0]?.id ?? null, changes: result.rowCount ?? 0 };
}
export async function get(sql, params=[]) {
  if(DB_ENGINE==='sqlite') return sqlite.prepare(sql).get(...params);
  const result=await pgExecutor().query(translateSql(sql),params);
  return result.rows[0];
}
export async function all(sql, params=[]) {
  if(DB_ENGINE==='sqlite') return sqlite.prepare(sql).all(...params);
  const result=await pgExecutor().query(translateSql(sql),params);
  return result.rows;
}
export async function atomic(fn) {
  if(DB_ENGINE==='sqlite'){
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result=await fn(); sqlite.exec('COMMIT'); return result; }
    catch(err){ try{sqlite.exec('ROLLBACK');}catch{} throw err; }
  }
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const result=await txContext.run(client,fn);
    await client.query('COMMIT');
    return result;
  }catch(err){
    try{await client.query('ROLLBACK');}catch{}
    throw err;
  }finally{client.release();}
}
