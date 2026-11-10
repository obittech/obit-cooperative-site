const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', 'frontend', file), 'utf8');
function storage(values = {}) {
  const items = new Map(Object.entries(values));
  return { getItem: key => items.get(key) || null, setItem: (key,value) => items.set(key,String(value)), removeItem: key => items.delete(key) };
}
test('API scopes session headers, preserves explicit tokens and clears expired application sessions', async () => {
  const calls = [], events = [];
  const ctx = vm.createContext({
    window: { OBIT_API_BASE: 'https://synthetic.invalid', dispatchEvent: event => events.push(event.type) },
    sessionStorage: storage({ obit_application_token:'application-test-token', obit_member_token:'member-test-token' }), localStorage: storage(),
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch: async (url, options) => { calls.push({url,options}); return { ok: true, json: async () => ({}) }; },
  });
  vm.runInContext(read('js/api.js'), ctx);
  for (const endpoint of ['/api/applications/12','/api/applications/12/submit','/api/kyc/session','/api/kyc/youverify_sandbox_test/status','/api/payments/membership/bank-transfer/12','/api/payments/membership/initialize']) {
    await vm.runInContext(`OBIT.get(${JSON.stringify(endpoint)})`,ctx);
    assert.equal(calls.at(-1).options.headers.Authorization,'Bearer application-test-token');
  }
  for (const endpoint of ['/api/applications/register','/api/applications/resume','/api/payments/membership/options','/api/auth/login','/api/market/listings','/api/admin/applications']) {
    await vm.runInContext(`OBIT.get(${JSON.stringify(endpoint)})`,ctx);
    assert.equal(calls.at(-1).options.headers.Authorization,undefined);
  }
  await vm.runInContext("OBIT.get('/api/applications/12', {token:'explicit'})",ctx);
  assert.equal(calls.at(-1).options.headers.Authorization,'Bearer explicit');
  ctx.fetch = async () => ({ok:false,status:401,json:async()=>({error:'Sign in'})});
  await assert.rejects(vm.runInContext("OBIT.get('/api/applications/12')",ctx), e=>e.status===401);
  assert.deepEqual(events,['obit-application-access-required']);
  assert.equal(ctx.sessionStorage.getItem('obit_application_token'),null);
  ctx.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({})};};
  await vm.runInContext("OBIT.get('/api/applications/12')",ctx);
  assert.equal(calls.at(-1).options.headers.Authorization,'Bearer member-test-token');
});
function setup({ id='12', token=null, get, post, search='' } = {}) {
  const nodes = new Map(), listeners = {}, sessions = [];
  const element = () => ({value:'',style:{},textContent:'',innerHTML:'',disabled:false,open:false,children:[],listeners:{},setAttribute(k,v){this[k]=v;},appendChild(child){this.children.push(child);},addEventListener(type,fn){this.listeners[type]=fn;},reportValidity(){return true;}});
  const node = id => { if(!nodes.has(id))nodes.set(id,element());return nodes.get(id); };
  const localStorage=storage(id?{obit_application_id:id}:{});
  const ctx=vm.createContext({
    document:{getElementById:node,createElement:element,querySelectorAll:()=>[],addEventListener(){},title:'Synthetic application'},
    window:{location:{search,pathname:'/apply.html',hash:''},history:{replaceState(){}},addEventListener:(type,fn)=>{listeners[type]=fn;},ObitDOB:{init(){},restore(){},validate(){return true;}},ObitLocations:{fillLgas(){},restore(){}}},
    OBIT:{get:get||(async()=>{const e=new Error('Sign in');e.status=401;throw e;}),post:post||(async()=>({})),getSession:()=>token,saveSession:(...args)=>sessions.push(args),clearSession:role=>sessions.push(['clear',role])},
    localStorage,URLSearchParams,setInterval(){},
  });
  vm.runInContext(read('js/apply.js'),ctx);
  return {ctx,node,localStorage,listeners,sessions,settle:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('legacy IDs are preserved while protected panels await credential resume',async()=>{
  const ui=setup();await ui.settle();
  assert.equal(ui.localStorage.getItem('obit_application_id'),'12'); assert.equal(ui.node('applicationResume').open,true);
  for(const step of ['profile','review','kyc','payment','done'])assert.equal(ui.node(`panel-${step}`).style.display,'none');
  assert.match(ui.node('applicationResumeMessage').textContent,/not been deleted/);
});
test('network failure does not silently discard an application or start a duplicate',async()=>{
  const ui=setup({get:async()=>{throw new Error('Network interrupted');}});await ui.settle();
  assert.equal(ui.localStorage.getItem('obit_application_id'),'12');assert.match(ui.node('alertBox').children.at(-1).textContent,/Do not register or pay again/);
  assert.equal(ui.node('panel-profile').style.display,'none');
});
test('credential resume stores scoped session, clears password and restores profile',async()=>{
  let resumed=false;const calls=[];
  const ui=setup({get:async()=>{if(!resumed){const e=new Error('Sign in');e.status=401;throw e;}return {id:27,status:'APPLICATION_STARTED',full_legal_name:'Synthetic Person',interests_json:'[]'};},post:async(path,body)=>{calls.push({path,body});resumed=true;return {application_id:27,application_token:'new-test-session'};}});await ui.settle();
  ui.node('resumeUsername').value='synthetic';ui.node('resumePassword').value='synthetic-password';
  await ui.node('applicationResumeForm').listeners.submit({preventDefault(){}});
  assert.equal(calls[0].path,'/api/applications/resume');assert.equal(calls[0].body.application_id,undefined);
  assert.equal(ui.localStorage.getItem('obit_application_id'),'27');assert.deepEqual(ui.sessions,[['application','new-test-session']]);
  assert.equal(ui.node('resumePassword').value,'');assert.equal(ui.node('panel-profile').style.display,'');assert.equal(ui.node('applicationResume').open,false);
});
test('failed credential resume preserves reference, clears password and permits retry',async()=>{
  const ui=setup({post:async()=>{throw new Error('Incorrect credentials.');}});await ui.settle();ui.node('resumePassword').value='wrong';
  await ui.node('applicationResumeForm').listeners.submit({preventDefault(){}});
  assert.equal(ui.localStorage.getItem('obit_application_id'),'12');assert.equal(ui.node('resumePassword').value,'');
  assert.equal(ui.node('btnResumeApplication').disabled,false);assert.match(ui.node('applicationResumeMessage').textContent,/Incorrect/);
});
test('new registration explicitly clears the old application session',async()=>{
  const ui=setup({search:'?new=1'});await ui.settle();
  assert.equal(ui.localStorage.getItem('obit_application_id'),null);assert.deepEqual(ui.sessions,[['clear','application']]);
});
test('server error text is rendered literally instead of HTML or event handlers',async()=>{
  const ui=setup();await ui.settle();
  const payload='<img src=x onerror="window.stolen=true"><script>alert(1)</script>';
  vm.runInContext(`showAlert(${JSON.stringify(payload)})`,ui.ctx);
  const alert=ui.node('alertBox').children.at(-1);
  assert.equal(alert.textContent,payload);assert.equal(alert.innerHTML,'');assert.equal(alert.role,'alert');
  assert.equal(ui.ctx.window.stolen,undefined);
});
