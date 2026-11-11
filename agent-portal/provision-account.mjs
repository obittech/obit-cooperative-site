import {pathToFileURL} from 'node:url';import {prepare} from './live-access.mjs';
const root=prepare();const {openStore,passwordHash,verify}=await import(pathToFileURL(root+'/store.mjs'));
let raw='';for await(const p of process.stdin){raw+=p;if(raw.length>8192)throw Error('Input too large')}
const input=JSON.parse(raw);const u=input.account;
if(!u||!/^[a-z0-9._-]{3,40}$/.test(u.username)||u.username.startsWith('demo.')||!['agent','admin'].includes(u.role)||typeof u.name!=='string'||!u.name.trim()||u.name.length>80||typeof u.password!=='string'||u.password.length<14||u.password.length>256)throw Error('Invalid account details');
const db=openStore(process.env.AGENT_DB);
try{
 const count=db.prepare('SELECT count(*) n FROM users').get().n;
 if(count===0){if(u.role!=='admin')throw Error('First account must be the administrator')}
 else{const a=db.prepare("SELECT * FROM users WHERE username=? AND active=1 AND role='admin'").get(input.adminUsername);if(!a||!await verify(String(input.adminPassword||''),a.password_hash))throw Error('Administrator authentication required')}
 const hash=await passwordHash(u.password);
 db.exec('BEGIN');
 try{db.prepare('INSERT INTO users(id,username,password_hash,name,role) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),u.username,hash,u.name.trim(),u.role);db.prepare('INSERT INTO audit(at,event,user_id) VALUES(?,?,?)').run(new Date().toISOString(),'account_created:'+u.username,null);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
 console.log('Account created. No credentials printed.');
}finally{db.close()}
