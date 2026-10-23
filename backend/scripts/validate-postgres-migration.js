// CI-only rehearsal of the real SQLite -> PostgreSQL cutover script.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obit-migration-'));
const sourcePath = path.join(temp, 'source.db');
const source = new DatabaseSync(sourcePath);
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || process.env.PGSSL !== 'disable') throw new Error('This rehearsal requires a local CI PostgreSQL service');
const admin = new pg.Client({ connectionString: adminUrl, ssl: false });
const databaseName = 'obit_migration_ci';
const targetUrl = new URL(adminUrl);
targetUrl.pathname = `/${databaseName}`;

try {
  // Use the same migration routine that prepares the live SQLite schema.
  const env = { ...process.env, DB_ENGINE: 'sqlite', DB_PATH: sourcePath };
  execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e',
    "const d=await import('./src/db.js'); await d.migrate();"], { env, stdio: 'pipe' });
  source.exec(`
    INSERT INTO users (id,email) VALUES (7,'migration-ci@example.com');
    INSERT INTO member_applications (id,user_id) VALUES (8,7);
    INSERT INTO members (id,application_id,user_id,member_code) VALUES (9,8,7,'OBT-CI-9');
    INSERT INTO ledger_accounts (id,member_id,balance,balance_kobo) VALUES (10,9,100.50,10050);
    INSERT INTO transactions (id,member_id,type,amount,amount_kobo,status)
      VALUES (11,9,'CONTRIBUTION',100.50,10050,'COMPLETE');
    INSERT INTO ledger_entries (id,ledger_account_id,transaction_id,direction,amount,amount_kobo)
      VALUES (12,10,11,'credit',100.50,10050);
    INSERT INTO market_listings (id,community_id,seller_member_id,title,price_kobo)
      VALUES (13,1,9,'CI listing',2000000);
  `);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const migrationEnv = { ...process.env, SQLITE_PATH: sourcePath, DATABASE_URL: targetUrl.toString(), PGSSL: 'disable' };
  const output = execFileSync(process.execPath, ['--experimental-sqlite', 'scripts/migrate-sqlite-to-postgres.js'],
    { env: migrationEnv, encoding: 'utf8' });
  assert.match(output, /"ok":true/);
  const target = new pg.Client({ connectionString: targetUrl.toString(), ssl: false });
  await target.connect();
  try {
    assert.equal(Number((await target.query('SELECT balance_kobo FROM ledger_accounts WHERE id=10')).rows[0].balance_kobo), 10050);
    assert.equal(Number((await target.query('SELECT price_kobo FROM market_listings WHERE id=13')).rows[0].price_kobo), 2000000);
    const inserted = await target.query("INSERT INTO users (email) VALUES ('after-migration-ci@example.com') RETURNING id");
    assert.ok(Number(inserted.rows[0].id) > 7, 'PostgreSQL identity sequence must advance');
  } finally {
    await target.end();
  }
  console.log('SQLite -> PostgreSQL migration rehearsal passed');
} finally {
  source.close();
  await admin.end();
  fs.rmSync(temp, { recursive: true, force: true });
}
