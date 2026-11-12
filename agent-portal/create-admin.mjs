import readline from 'node:readline/promises';
import {Writable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {prepare} from './live-access.mjs';
const root=prepare();const {openStore,passwordHash}=await import(pathToFileURL(root+'/store.mjs'));
const db=openStore(process.env.AGENT_DB);
if(db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n){db.close();throw Error('Administrator already exists. Use authenticated provisioning.')}
let mute=false;
const output=new Writable({write(chunk,encoding,done){if(!mute)process.stdout.write(chunk,encoding);done()}});
const rl=readline.createInterface({input:process.stdin,output,terminal:true});
async function secret(label){process.stdout.write(label);mute=true;try{return await rl.question('')}finally{mute=false;process.stdout.write('\n')}}
try{const username=(await rl.question('Choose administrator username [chief.obinna]: ')).trim()||'chief.obinna';if(!/^[a-z0-9._-]{3,40}$/.test(username)||username.startsWith('demo.'))throw Error('Invalid username');
const name=(await rl.question('Administrator name [Chief Obinna]: ')).trim()||'Chief Obinna';
if(name.length>80)throw Error('Name too long');
const password=await secret('Choose password (14+ characters, hidden): ');
const confirm=await secret('Confirm password (hidden): ');
if(password!==confirm||password.length<14||password.length>256)throw Error('Passwords must match and be 14 to 256 characters');
const hash=await passwordHash(password);
db.exec('BEGIN IMMEDIATE');try{if(db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n)throw Error('Administrator already exists');const id=randomUUID();db.prepare('INSERT INTO users(id,username,password_hash,name,role) VALUES(?,?,?,?,?)').run(id,username,hash,name,'admin');db.prepare('INSERT INTO audit(at,event,user_id) VALUES(?,?,?)').run(new Date().toISOString(),'first_administrator_created',id);db.exec('COMMIT');console.log('Administrator created. Sign in at https://agent.obitcooperative.com/')}catch(e){db.exec('ROLLBACK');throw e}
}finally{rl.close();db.close()}
